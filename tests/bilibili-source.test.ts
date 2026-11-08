// Bilibili watch-history source (v2.2, ledger #f575a6): filters, captions,
// credential priority, 24h bvid dedupe, silent -101, per-seed TTL override.
// All network goes through an injected fake fetch — no real request is made.

import { sandboxDir } from './_sandbox.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import { loadPolicy } from '../src/config/load.js';
import { assertPolicy, type Policy } from '../src/config/schema.js';
import { saveJson } from '../src/vault/vault.js';
import { addSeed, activeSeeds, gcPool, loadPool, seedsFilePath } from '../src/seeds/pool.js';
import {
  BILI_SESSION_FILE,
  BILI_SEED_TTL_DAYS,
  bilibiliStatePath,
  fetchBiliHistory,
  parseSessdata,
  pruneBvids,
  runBilibiliSource,
  sanitizeTitle,
  seedTextFor,
  shouldDropRecord,
  type BiliRecord,
  type BiliRunResult,
} from '../src/sources/bilibili.js';

const DAY_MS = 86_400_000;

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;
let policy: Policy;
const now = Date.parse('2026-11-09T10:00:00.000Z');

beforeEach(() => {
  sandbox = sandboxDir('hb-bili-source-');
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  guard = createPathGuard(workspace().dataDir);
  policy = loadPolicy(guard, workspace().configDir, workspace().settingsDir);
  requests.length = 0; // the fake-fetch log is shared across cases
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
});

// ── helpers ──────────────────────────────────────────────────────────────

interface CapturedRequest { url: string; cookie: string | undefined }
const requests: CapturedRequest[] = [];

/** Fake fetch: records the request, answers code/list without any network. */
function fakeFetch(code: number, list: unknown[]) {
  return (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({ url: String(url), cookie: headers.Cookie });
    return {
      ok: true,
      json: async () => ({ code, data: { list } }),
    } as unknown as Response;
  }) as typeof fetch;
}

function rec(
  overrides: Partial<Omit<BiliRecord, 'history'>> & { title: string; bvid?: string; business?: string },
): BiliRecord {
  const { bvid, business, ...rest } = overrides;
  return {
    duration: 600,
    progress: 600,
    history: { bvid: bvid ?? 'BV1test', business: business ?? 'archive' },
    ...rest,
  } as BiliRecord;
}

async function run(fetchImpl?: typeof fetch, at = now): Promise<BiliRunResult> {
  return runBilibiliSource({
    guard,
    paths: workspace(),
    policy,
    ...(fetchImpl ? { fetchImpl } : {}),
    now: at,
  });
}

// ── credentials ──────────────────────────────────────────────────────────

test('parseSessdata: whole cookie string, bare value, none', () => {
  assert.equal(parseSessdata('a=1; SESSDATA=abc123; b=2'), 'abc123');
  assert.equal(parseSessdata('abc123'), 'abc123');
  assert.equal(parseSessdata('a=1; b=2'), null);
  assert.equal(parseSessdata(''), null);
});

test('no credential (neither vault nor cookieFile) -> silent skip, no fetch', async () => {
  const r = await run(fakeFetch(0, []));
  assert.equal(r.skipped, 'no-credential');
  assert.equal(requests.length, 0);
});

test('cookieFile credential is picked up when the vault is empty', async () => {
  const cookieFile = path.join(sandbox, 'bili-cookie.txt');
  fs.writeFileSync(cookieFile, 'SESSDATA=filetok; buvid=abc', 'utf8');
  policy.sources = { bilibili: { cookieFile } };
  const r = await run(fakeFetch(0, []));
  assert.equal(r.skipped, undefined);
  assert.equal(requests[0]!.cookie, 'SESSDATA=filetok');
});

test('vault credential wins over cookieFile', async () => {
  saveJson(guard, path.join(workspace().dataDir, BILI_SESSION_FILE), { sessdata: 'vaulttok', savedAt: now });
  const cookieFile = path.join(sandbox, 'bili-cookie.txt');
  fs.writeFileSync(cookieFile, 'SESSDATA=filetok', 'utf8');
  policy.sources = { bilibili: { cookieFile } };
  await run(fakeFetch(0, []));
  assert.equal(requests[0]!.cookie, 'SESSDATA=vaulttok');
});

test('bilibili-session.json present but sessdata EMPTY -> falls back to cookieFile', async () => {
  saveJson(guard, path.join(workspace().dataDir, BILI_SESSION_FILE), { sessdata: '', savedAt: now });
  const cookieFile = path.join(sandbox, 'bili-cookie.txt');
  fs.writeFileSync(cookieFile, 'SESSDATA=filetok', 'utf8');
  policy.sources = { bilibili: { cookieFile } };
  await run(fakeFetch(0, []));
  assert.equal(requests[0]!.cookie, 'SESSDATA=filetok');
});

test('a whole cookie string in the sessdata field is parsed (SESSDATA= extracted)', async () => {
  saveJson(guard, path.join(workspace().dataDir, BILI_SESSION_FILE), { sessdata: 'SESSDATA=cookietok; buvid=1', savedAt: now });
  await run(fakeFetch(0, []));
  assert.equal(requests[0]!.cookie, 'SESSDATA=cookietok');
});

test('enabled: false hard-disables even with a credential', async () => {
  saveJson(guard, path.join(workspace().dataDir, BILI_SESSION_FILE), { sessdata: 'vaulttok', savedAt: now });
  policy.sources = { bilibili: { enabled: false } };
  const r = await run(fakeFetch(0, []));
  assert.equal(r.skipped, 'disabled');
  assert.equal(requests.length, 0);
});

// ── fetch failure modes: silent, never throwing ──────────────────────────

test('-101 (cookie expired) -> silent skip, no throw, one debug line', async () => {
  saveJson(guard, path.join(workspace().dataDir, BILI_SESSION_FILE), { sessdata: 'vaulttok', savedAt: now });
  const debugLines: string[] = [];
  const r = await runBilibiliSource({
    guard,
    paths: workspace(),
    policy,
    fetchImpl: fakeFetch(-101, []),
    now,
    debug: (msg) => debugLines.push(msg),
  });
  assert.equal(r.skipped, 'code--101');
  assert.equal(debugLines.length, 1);
  // Throttled as an attempt: a failing credential must not hammer the API.
  const r2 = await run(fakeFetch(0, []), now + 60_000);
  assert.equal(r2.skipped, 'throttled');
});

test('transport failure (network error / bad payload) -> silent skip', async () => {
  saveJson(guard, path.join(workspace().dataDir, BILI_SESSION_FILE), { sessdata: 'vaulttok', savedAt: now });
  const throwing = (async (): Promise<Response> => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
  const r1 = await run(throwing);
  assert.equal(r1.skipped, 'fetch-failed');
  const badPayload = (async () => ({ ok: true, json: async () => ({ weird: true }) })) as unknown as typeof fetch;
  const r2 = await run(badPayload, now + 2 * 3_600_000); // past the throttle
  assert.equal(r2.skipped, 'fetch-failed');
});

// ── the three hard filters ───────────────────────────────────────────────

test('filter 1: duration < 90s -> dropped', async () => {
  saveJson(guard, path.join(workspace().dataDir, BILI_SESSION_FILE), { sessdata: 'vaulttok', savedAt: now });
  assert.equal(shouldDropRecord({ title: '短', duration: 89, history: { bvid: 'BV1', business: 'archive' } }), 'short');
  const r = await run(fakeFetch(0, [rec({ title: '短视频', duration: 89 })]));
  assert.equal(r.dropped, 1);
  assert.equal(r.added, 0);
});

test('filter 2: business === live -> dropped', async () => {
  assert.equal(shouldDropRecord({ title: '直播', duration: 6000, history: { bvid: 'BV1', business: 'live' } }), 'live');
  saveJson(guard, path.join(workspace().dataDir, BILI_SESSION_FILE), { sessdata: 'vaulttok', savedAt: now });
  const r = await run(fakeFetch(0, [rec({ title: '直播', business: 'live' })]));
  assert.equal(r.dropped, 1);
});

test('filter 3: progress/duration < 0.1 -> dropped', async () => {
  assert.equal(shouldDropRecord({ title: '点开就走', duration: 600, progress: 30, history: { bvid: 'BV1', business: 'archive' } }), 'barely-watched');
  assert.equal(shouldDropRecord({ title: '刚过线', duration: 600, progress: 60, history: { bvid: 'BV1', business: 'archive' } }), null);
});

test('progress < 0 boundary: unknown progress passes and the caption never mentions it', async () => {
  assert.equal(shouldDropRecord({ title: 'x', duration: 600, progress: -1, history: { bvid: 'BV1', business: 'archive' } }), null);
  assert.equal(seedTextFor({ title: '某深度视频', duration: 600, progress: -1 }), '你刚看完《某深度视频》');
  assert.equal(/分钟/.test(seedTextFor({ title: '某深度视频', duration: 600, progress: -1 }) ?? ''), false);
});

// ── the three caption templates ──────────────────────────────────────────

test('captions: finished / mid / pgc, each <= 60 chars', () => {
  // 看完: progress >= duration * 0.9
  assert.equal(seedTextFor({ title: '深海纪录片', duration: 600, progress: 570 }), '你刚看完《深海纪录片》');
  // 中途: 0 < progress < duration * 0.9 -> 第 N 分钟
  assert.equal(seedTextFor({ title: '深海纪录片', duration: 600, progress: 65 }), '《深海纪录片》你看到第 2 分钟');
  // 番剧影视 (pgc): 在追《标题》· 分P标题（有分P才带）
  assert.equal(
    seedTextFor({ title: '某动画 第二季', show_title: '第3话 雨夜', duration: 1400, progress: 700, history: { bvid: 'BV2', business: 'pgc' } }),
    '你在追《某动画 第二季》· 第3话 雨夜',
  );
  assert.equal(seedTextFor({ title: '某动画 第二季', duration: 1400, progress: 700, history: { bvid: 'BV2', business: 'pgc' } }), '你在追《某动画 第二季》');
  // length cap
  const long = seedTextFor({ title: '很长的标题'.repeat(20), duration: 600, progress: 600 });
  assert.ok(long && long.length <= 60);
});

test('sanitizeTitle: 《 -> （, 》 -> ） so the wrapper does not nest', () => {
  assert.equal(sanitizeTitle('《三体》解读'), '（三体）解读');
  assert.equal(sanitizeTitle('【解说】《原神》新版本'), '【解说】（原神）新版本');
});

test('pgc record with a nested title round-trips through the wrapper', () => {
  const text = seedTextFor({ title: '《三体》剧集', duration: 1400, progress: 1400, history: { bvid: 'BV3', business: 'pgc' } });
  assert.equal(text, '你在追《（三体）剧集》');
  assert.equal((text ?? '').match(/《/g)?.length, 1); // only OUR wrapper remains
});

// ── 24h bvid dedupe ──────────────────────────────────────────────────────

test('same bvid within 24h does not re-enter the pool; after the window it may', async () => {
  saveJson(guard, path.join(workspace().dataDir, BILI_SESSION_FILE), { sessdata: 'vaulttok', savedAt: now });
  const item = rec({ title: '第一个视频', bvid: 'BV1abc' });
  const r1 = await run(fakeFetch(0, [item]));
  assert.equal(r1.added, 1);
  assert.equal(activeSeeds(loadPool(guard, seedsFilePath(workspace().dataDir))).length, 1);

  // 2h later (past the pull throttle): the bvid is still inside the 24h set.
  const r2 = await run(fakeFetch(0, [item]), now + 2 * 3_600_000);
  assert.equal(r2.deduped, 1);
  assert.equal(r2.added, 0);
  assert.equal(activeSeeds(loadPool(guard, seedsFilePath(workspace().dataDir))).length, 1);

  // > 24h: the bvid expired from the set, so addSeed is reached again (the
  // pool's own text dedup then keeps the pool clean — no double entry).
  const r3 = await run(fakeFetch(0, [item]), now + 25 * 3_600_000);
  assert.equal(r3.added, 0);
  assert.equal(r3.deduped, 1);
  assert.equal(activeSeeds(loadPool(guard, seedsFilePath(workspace().dataDir))).length, 1);
});

test('pruneBvids: entries older than 24h fall out of the set', () => {
  const state = { lastFetchAt: now, bvids: [{ bvid: 'BVold', at: now - 25 * 3_600_000 }, { bvid: 'BVnew', at: now - 1_000 }] };
  const pruned = pruneBvids(state, now);
  assert.deepEqual(pruned.bvids.map((e) => e.bvid), ['BVnew']);
});

// ── per-seed TTL override (hard 2-day expiry) ────────────────────────────

test('addSeed ttlDaysOverride wins over the tag TTL; absent keeps the tag default', () => {
  const file = seedsFilePath(workspace().dataDir);
  const withOverride = addSeed(guard, file, policy, { text: '覆盖TTL的素材', tag: 'scene', source: 'bilibili', ttlDaysOverride: 2 }, now);
  assert.equal(withOverride.kind, 'added');
  assert.equal(withOverride.seed.ttlDaysOverride, BILI_SEED_TTL_DAYS);
  assert.equal(withOverride.seed.expiresAt, new Date(now + 2 * DAY_MS).toISOString());

  const without = addSeed(guard, file, policy, { text: '默认TTL的素材', tag: 'scene', source: 'bilibili' }, now + 1);
  assert.equal(without.seed.ttlDaysOverride, undefined);
  assert.equal(without.seed.expiresAt, new Date(now + 1 + policy.seeds.ttlDays.scene * DAY_MS).toISOString());
});

test('bilibili-sourced seeds hard-expire in 2 days and gc archives them as expired', async () => {
  saveJson(guard, path.join(workspace().dataDir, BILI_SESSION_FILE), { sessdata: 'vaulttok', savedAt: now });
  await run(fakeFetch(0, [rec({ title: '两天后应过期', bvid: 'BV1ttl' })]));
  const file = seedsFilePath(workspace().dataDir);
  const seed = activeSeeds(loadPool(guard, file))[0]!;
  assert.equal(seed.ttlDaysOverride, 2);
  assert.equal(seed.source, 'bilibili');
  assert.equal(seed.category, 'topic');
  assert.equal(seed.expiresAt, new Date(now + 2 * DAY_MS).toISOString());

  const report = gcPool(guard, file, policy, now + 2 * DAY_MS + 1_000);
  assert.equal(report.expired, 1);
  const after = loadPool(guard, file).seeds.find((s) => s.id === seed.id)!;
  assert.equal(after.status, 'archived');
  assert.equal(after.retireReason, 'expired');
});

// ── config schema: optional, backward compatible ─────────────────────────

test('assertPolicy: a policy without sources still validates; a good sources block validates', () => {
  const factoryRaw = JSON.parse(fs.readFileSync(path.join(workspace().configDir, 'policy.json'), 'utf8')) as unknown;
  assertPolicy(factoryRaw); // no sources key at all
  const factoryObj = factoryRaw as unknown as Record<string, unknown>;
  assertPolicy({
    ...factoryObj,
    sources: { bilibili: { enabled: false, cookieFile: 'D:/x/cookies.txt' } },
  });
});

test('assertPolicy: a malformed sources block is rejected', () => {
  const factoryRaw = JSON.parse(fs.readFileSync(path.join(workspace().configDir, 'policy.json'), 'utf8')) as Record<string, unknown>;
  assert.throws(() => assertPolicy({ ...factoryRaw, sources: { bilibili: { enabled: 'yes' } } }));
  assert.throws(() => assertPolicy({ ...factoryRaw, sources: { bilibili: { cookieFile: 42 } } }));
});

// ── fetch request shape ──────────────────────────────────────────────────

test('fetchBiliHistory sends the cursor URL, cookie and a desktop UA', async () => {
  await fetchBiliHistory('sessval', fakeFetch(0, []));
  const req = requests[requests.length - 1]!;
  assert.ok(req.url.startsWith('https://api.bilibili.com/x/web-interface/history/cursor'));
  assert.ok(req.url.includes('ps=8'));
  assert.equal(req.cookie, 'SESSDATA=sessval');
});
