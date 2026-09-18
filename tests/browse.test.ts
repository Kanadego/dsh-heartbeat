import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import { loadPolicy } from '../src/config/load.js';
import type { Policy } from '../src/config/schema.js';
import {
  adviseWander,
  browseStatePath,
  checkWatchlist,
  completeWander,
  inWanderWindow,
  pickFocus,
} from '../src/browse/browse.js';

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;
let paths: ReturnType<typeof workspace>;
let policy: Policy;

const NOON = new Date('2026-09-06T12:30:00.000+08:00');

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-browse-'));
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  paths = initWorkspace();
  guard = createPathGuard(paths.dataDir);
  policy = loadPolicy(guard, paths.configDir, paths.settingsDir);
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
});

test('inWanderWindow matches noon/evening windows only', () => {
  assert.equal(inWanderWindow(NOON, policy.browse.windows), '11:00-15:00');
  assert.equal(inWanderWindow(new Date('2026-09-06T18:00:00.000+08:00'), policy.browse.windows), '17:00-21:00');
  assert.equal(inWanderWindow(new Date('2026-09-06T09:00:00.000+08:00'), policy.browse.windows), null);
  assert.equal(inWanderWindow(new Date('2026-09-06T16:00:00.000+08:00'), policy.browse.windows), null);
});

test('adviseWander: outside window -> skipped with time', () => {
  const a = adviseWander(guard, paths, policy, new Date('2026-09-06T09:00:00.000+08:00'));
  assert.equal(a.focus, null);
  assert.match(a.skipped!, /window/);
});

test('adviseWander: inside window first time -> advice with query', () => {
  const a = adviseWander(guard, paths, policy, NOON);
  assert.equal(a.skipped, null);
  assert.ok(a.focus);
  assert.match(a.query!, /2026 最新/);
});

test('adviseWander: min-interval blocks a second visit within 4h', () => {
  completeWander(guard, paths, 'AI 模型消息', NOON.getTime() - 3600_000);
  const a = adviseWander(guard, paths, policy, NOON);
  assert.equal(a.skipped, 'min-interval');
});

test('adviseWander: focus cooldown rotates to the next interest (3 days)', () => {
  const used = 'AI 模型消息';
  completeWander(guard, paths, used, NOON.getTime() - 3 * 86_400_000 + 60_000); // just inside cooldown
  const a = adviseWander(guard, paths, policy, NOON);
  assert.notEqual(a.focus, used);
  assert.ok(a.focus);
});

test('pickFocus round-robins by least-recent history', () => {
  const interests = { interests: ['甲', '乙', '丙'], _schedule: { focus_cooldown_days: 0 } };
  const st = {
    targets: {},
    last_check_at: 0,
    wander: { focusHistory: { 甲: 5, 乙: 2 } as Record<string, number>, focusCount: {} as Record<string, number>, last_wander_at: 0 },
  };
  assert.equal(pickFocus(st, interests, 10), '丙');
  st.wander.focusHistory['丙'] = 9;
  assert.equal(pickFocus(st, interests, 10), '乙');
});

test('checkWatchlist: first sight registers silently, change produces material', async () => {
  let npmCalls = 0;
  const fetcher = async (url: string) => {
    if (url.includes('registry.npmjs.org')) {
      npmCalls += 1;
      const version = npmCalls >= 3 ? '2.0.0' : '1.0.0';
      return { ok: true, status: 200, json: async () => ({ version }) };
    }
    return { ok: false, status: 404, json: async () => ({}) }; // github targets: no releases -> skipped
  };
  const one = await checkWatchlist(guard, paths, { fetcher, throttleOk: true });
  assert.equal(one.items.length, 0); // 首见不产素材
  assert.equal(one.checked > 0, true);
  const two = await checkWatchlist(guard, paths, { fetcher, throttleOk: true });
  assert.equal(two.items.length, 0); // same version -> no news
  const three = await checkWatchlist(guard, paths, { fetcher, throttleOk: true });
  assert.equal(three.items.length, 1); // version change -> material
  assert.match(three.items[0]!.text, /1\.0\.0 -> 2\.0\.0/);
  assert.equal(three.items[0]!.confidence, 0.4);
});

test('checkWatchlist throttles to 6h by default', async () => {
  const fetcher = async () => { throw new Error('should not be called'); };
  await checkWatchlist(guard, paths, { fetcher: async () => ({ ok: true, status: 200, json: async () => ({ version: '9' }) }), throttleOk: true });
  const second = await checkWatchlist(guard, paths, { fetcher });
  assert.equal(second.checked, 0);
  assert.equal(second.items.length, 0);
});

test('completeWander records throttle timestamps (browse.json encrypted)', () => {
  const r = completeWander(guard, paths, '独立游戏', Date.now());
  assert.equal(r.count, 1);
  const st = fs.readFileSync(browseStatePath(paths)).toString('utf8');
  // encrypted at rest: the file must NOT contain the focus in plaintext
  assert.equal(st.includes('独立游戏'), false);
  assert.equal(st.slice(0, 5), 'KHBV1');
});

// ── M4: refill wander (2026-09-18 spec ⑥) ─────────────────────────────────

import {
  adviseRefillWander,
  REFILL_MAX_PER_DAY,
  REFILL_TOPIC_THRESHOLD,
} from '../src/browse/browse.js';
import { addSeed, loadPool, normalizeCategory, seedsFilePath, activeSeeds } from '../src/seeds/pool.js';

const seedFile = () => seedsFilePath(paths.dataDir);

test('spec ⑥: refill triggers at topic<=4, bypasses window and min-interval', () => {
  // off-window late night + min-interval exhausted: normal wander would skip
  const night = new Date('2026-09-06T23:30:00.000+08:00');
  for (let i = 0; i < REFILL_TOPIC_THRESHOLD; i += 1) {
    addSeed(guard, seedFile(), policy, { text: `话题 ${i}`, topic: `t${i}`, source: 'browse', tag: 'scene' }, night.getTime() + i);
  }
  const advice = adviseRefillWander(guard, paths, policy, night);
  assert.equal(advice.skipped, null, 'refill fires despite off-window and pool status');
  assert.ok(advice.focus, 'a focus is picked');
  assert.match(advice.query!, /2026 最新/);
  // one more topic seed (5 > 4) and it stands down
  addSeed(guard, seedFile(), policy, { text: '话题 补充', topic: 't9', source: 'browse', tag: 'scene' }, night.getTime() + 10);
  const over = adviseRefillWander(guard, paths, policy, night);
  assert.match(over.skipped!, /topic-stock-ok/);
});

test('spec ⑥: daily cap 2 registered via completeWander refill flag', () => {
  const noon = new Date('2026-09-06T12:30:00.000+08:00');
  for (let i = 0; i < 2; i += 1) {
    addSeed(guard, seedFile(), policy, { text: `话题 ${i}`, topic: `t${i}`, source: 'browse', tag: 'scene' }, noon.getTime() + i);
  }
  completeWander(guard, paths, 'AI 模型消息', noon.getTime(), { refill: true });
  const once = adviseRefillWander(guard, paths, policy, noon);
  assert.equal(once.skipped, null, 'second refill of the day still allowed');
  completeWander(guard, paths, '独立游戏', noon.getTime(), { refill: true });
  const capped = adviseRefillWander(guard, paths, policy, noon);
  assert.match(capped.skipped!, /refill-daily-cap\(2\)/);
  // non-refill wander does NOT consume the daily quota
  completeWander(guard, paths, '网络热梗', noon.getTime());
  const stillCapped = adviseRefillWander(guard, paths, policy, noon);
  assert.match(stillCapped.skipped!, /refill-daily-cap\(2\)/);
  // next local day resets the quota
  const tomorrow = new Date(noon.getTime() + 24 * 3600_000);
  const nextDay = adviseRefillWander(guard, paths, policy, tomorrow);
  assert.equal(nextDay.skipped, null);
});

test('spec ⑥: focus cooldown (3d) still applies to refill', async () => {
  const noon = new Date('2026-09-06T12:30:00.000+08:00');
  addSeed(guard, seedFile(), policy, { text: '话题 0', topic: 't0', source: 'browse', tag: 'scene' }, noon.getTime());
  const cooled = ['AI 模型消息', 'DSH 生态消息', '独立游戏'];
  for (const f of cooled) completeWander(guard, paths, f, noon.getTime());
  // pickFocus round-robins: the refill focus must not be one of the cooled ones
  const advice = adviseRefillWander(guard, paths, policy, noon);
  assert.ok(advice.focus, 'factory list has 14 interests, a fresh one exists');
  assert.ok(!cooled.includes(advice.focus!), 'cooled focus was not picked');
  // cool down every factory interest -> refill has nowhere to go
  const { loadInterests } = await import('../src/browse/browse.js');
  for (const f of loadInterests(paths).interests ?? []) {
    completeWander(guard, paths, f, noon.getTime());
  }
  const drained = adviseRefillWander(guard, paths, policy, noon);
  assert.equal(drained.skipped, 'no-focus');
});

test('spec ⑤/⑥: loadPool rows carry category so refill counting matches the pool', () => {
  const noon = new Date('2026-09-06T12:30:00.000+08:00');
  addSeed(guard, seedFile(), policy, { text: '聊天种子', source: 'chat' }, noon.getTime());
  addSeed(guard, seedFile(), policy, { text: '话题种子', source: 'browse', tag: 'scene' }, noon.getTime());
  const db = loadPool(guard, seedFile());
  const cats = activeSeeds(db).map((s) => normalizeCategory(s.category)).sort();
  assert.deepEqual(cats, ['chat', 'topic']);
});
