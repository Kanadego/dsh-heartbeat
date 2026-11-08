// Bilibili watch-history material source (账本 #f575a6): a PASSIVE "闲逛素材"
// feed built from the user's own B站 viewing history (research doc
// docs/api-research-netease-bilibili.md §2.2/§4 — SESSDATA read-only route).
//
// Discipline (all from the research doc's hard rules):
//   - Credential is read-only, never written: the login subtask's session
//     file `bilibili-session.json` ({ sessdata, savedAt }, vault-encrypted
//     like gate.json) first, then the configured cookieFile; neither -> the
//     source silently does nothing. No error, no log noise.
//   - Pull: GET /x/web-interface/history/cursor?ps=8, Cookie SESSDATA, desktop
//     UA. code !== 0 (notably -101 cookie expired) -> silently skip the round,
//     at most one debug line. Never throws, never retries in a loop.
//   - Frequency: at most one pull per 2h; the last-attempt timestamp is
//     persisted, so a restart cannot hammer the API. Failures never touch the
//     heartbeat main flow.
//   - Material text never names a point in time ("不报精确时间点") and stays
//     <= 60 chars; 《》 inside titles become （） so the 《》 wrapper nests.
//   - Dedup: the same bvid does not enter the pool twice within 24h (module-
//     owned small state file — the smallest-change option vs threading the set
//     through the seeds pool).
//   - Lifespan: browse material hard-expires in 2 days via the per-seed
//     ttlDaysOverride (seeds pool feature this module consumes, not extends).
//
// The orchestrator is NOT wired here on purpose: the source owns its own
// interval timer and is started/stopped from the plugin entry (index.ts) with
// ctx.effect, so a plugin reload cannot leak a timer.

import fs from 'node:fs';
import path from 'node:path';
import type { PathGuard } from '../core/path-guard.js';
import type { WorkspacePaths } from '../core/paths.js';
import type { Policy } from '../config/schema.js';
import { loadJson, saveJson } from '../vault/vault.js';
import { addSeed, seedsFilePath, type SeedAuditFn } from '../seeds/pool.js';

// ── constants ───────────────────────────────────────────────────────────

export const BILI_HISTORY_URL = 'https://api.bilibili.com/x/web-interface/history/cursor?ps=8';

/** Ordinary desktop browser UA (research doc: stay close to the user's daily
 *  browser shape; do not advertise a third-party client). */
export const BILI_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Credential file written by the login subtask (s2) after a successful
 * login: <dataDir>/bilibili-session.json = { "sessdata": "...", "savedAt":
 * <ms> }, stored through saveJson (same vault encryption as gate.json).
 * THIS NAME/SHAPE IS THE CROSS-SUBTASK CONTRACT — do not rename it here
 * without synchronising the login side.
 */
export const BILI_SESSION_FILE = 'bilibili-session.json';

/** Module-owned small state file (last fetch timestamp + 24h bvid set). */
export const BILI_STATE_FILE = 'bilibili-source.json';

/** Filters (requirement, each unit-tested). */
export const BILI_MIN_DURATION_SEC = 90;
export const BILI_MIN_WATCH_RATIO = 0.1;

/** Caption thresholds. */
export const BILI_FINISHED_RATIO = 0.9;
export const BILI_TEXT_MAX_CHARS = 60;

/** The same bvid does not re-enter the pool within this window. */
export const BILI_DEDUPE_WINDOW_MS = 24 * 60 * 60_000;

/** Hard TTL for browse material from this source (Seed.ttlDaysOverride). */
export const BILI_SEED_TTL_DAYS = 2;

/** At most one pull per interval (persisted across restarts). */
export const BILI_FETCH_INTERVAL_MS = 2 * 60 * 60_000;

// ── credential resolution (read-only, never written) ────────────────────

/** Extract the SESSDATA value from a raw cookie string. Tolerates both a
 *  whole cookie header ("a=1; SESSDATA=xxx; b=2") and a bare value. */
export function parseSessdata(cookieText: string): string | null {
  const m = /(?:^|[;\s])SESSDATA=([^;\s]+)/.exec(cookieText);
  if (m && m[1]) return m[1];
  const bare = cookieText.trim();
  // A bare value still must not be a cookie assignment of something else.
  if (bare && !/^[A-Za-z_]+=/m.test(bare)) return bare;
  return null;
}

/** Read the session credential the login subtask (s2) wrote. The `.sessdata`
 *  field is the raw SESSDATA value; a cookie-string-shaped value is accepted
 *  too (parsed), everything else counts as absent. */
export function readVaultSessdata(guard: PathGuard, dataDir: string): string | null {
  try {
    const session = loadJson<{ sessdata?: unknown; savedAt?: unknown }>(
      guard,
      path.join(dataDir, BILI_SESSION_FILE),
    );
    const field = session?.sessdata;
    if (typeof field !== 'string') return null;
    const raw = field.trim();
    if (!raw) return null;
    // Tolerate a whole cookie string pasted into the field; a bare value
    // (the s2 contract) goes through untouched.
    if (raw.includes('SESSDATA=')) return parseSessdata(raw);
    return raw;
  } catch {
    return null; // unreadable container: the source stays off, silently
  }
}

/**
 * Read the configured cookie file. This is the ONE deliberate raw-fs read in
 * the module: cookieFile is a USER-configured path (typically the browser's
 * exported cookie, outside the data dir), so the path guard cannot apply —
 * the read never writes and never follows into directory listings.
 */
export function readCookieFileSessdata(file: string): string | null {
  if (!file) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw) return null;
    const v = parseSessdata(raw);
    return v || null;
  } catch {
    return null; // missing/unreadable file: fall through silently
  }
}

/** Priority: vault first, then cookieFile; neither -> null (source off). */
export function resolveSessdata(
  guard: PathGuard,
  dataDir: string,
  cookieFile?: string,
): string | null {
  return readVaultSessdata(guard, dataDir) ?? readCookieFileSessdata(cookieFile ?? '');
}

// ── filtering + captions (pure, unit-tested) ────────────────────────────

/** One history/cursor record, only the fields this module reads. */
export interface BiliRecord {
  title?: string;
  show_title?: string;
  /** Seconds watched; < 0 or missing = unknown (research doc field notes). */
  progress?: number;
  /** Total seconds. */
  duration?: number;
  history?: {
    bvid?: string;
    business?: string;
    part?: string;
  };
}

/** Drop decision (three hard rules, in order). Returns the reason or null. */
export function shouldDropRecord(r: BiliRecord): string | null {
  // Rule 1: too short -> not material. A missing duration cannot be judged -> drop.
  if (typeof r.duration !== 'number' || r.duration < BILI_MIN_DURATION_SEC) return 'short';
  // Rule 2: live streams are ephemeral, not material.
  if (r.history?.business === 'live') return 'live';
  // Rule 3: barely opened (< 10% watched) -> noise. progress < 0 (or missing)
  // is "unknown" per the spec and passes.
  const progress = r.progress;
  if (typeof progress === 'number' && progress >= 0 && r.duration > 0
    && progress / r.duration < BILI_MIN_WATCH_RATIO) {
    return 'barely-watched';
  }
  return null;
}

/** 《》 inside a title would nest with our own 《》 wrapper -> plain brackets. */
export function sanitizeTitle(t: string): string {
  return t.replace(/《/g, '（').replace(/》/g, '）').replace(/\s+/g, ' ').trim();
}

/** Seed brief for one record, or null when it has no usable title. */
export function seedTextFor(r: BiliRecord): string | null {
  const rawTitle = r.title?.trim() || r.show_title?.trim() || '';
  if (!rawTitle) return null;
  const title = sanitizeTitle(rawTitle);
  if (!title) return null;
  const business = r.history?.business;
  let text: string;
  if (business === 'pgc') {
    // 番剧影视：在追《标题》· 分P标题（有分P才带）
    const part = r.show_title?.trim();
    text = part && part !== rawTitle ? `在追《${title}》· ${sanitizeTitle(part)}` : `在追《${title}》`;
  } else {
    const progress = typeof r.progress === 'number' ? r.progress : -1;
    const duration = typeof r.duration === 'number' ? r.duration : 0;
    const finished = progress < 0
      || (duration > 0 && progress >= duration * BILI_FINISHED_RATIO);
    if (finished) {
      text = `刚看完《${title}》`; // progress unknown -> no mention of progress
    } else {
      const minute = Math.max(1, Math.ceil(progress / 60));
      text = `《${title}》看到第 ${minute} 分钟`;
    }
  }
  return text.length > BILI_TEXT_MAX_CHARS ? text.slice(0, BILI_TEXT_MAX_CHARS) : text;
}

// ── module state (last fetch + 24h bvid set) ────────────────────────────

export interface BiliSourceState {
  /** Last PULL ATTEMPT (success or failure) — the throttle clock. */
  lastFetchAt: number;
  /** bvids that entered (or were skipped as) the pool recently. */
  bvids: { bvid: string; at: number }[];
}

export function emptyBiliState(): BiliSourceState {
  return { lastFetchAt: 0, bvids: [] };
}

export function bilibiliStatePath(dataDir: string): string {
  return path.join(dataDir, BILI_STATE_FILE);
}

/** Lenient load (H-65 style): garbage rows fall back to the empty state. */
export function normalizeBiliState(raw: unknown): BiliSourceState {
  const out = emptyBiliState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Partial<BiliSourceState>;
  if (typeof r.lastFetchAt === 'number' && Number.isFinite(r.lastFetchAt) && r.lastFetchAt >= 0) {
    out.lastFetchAt = r.lastFetchAt;
  }
  if (Array.isArray(r.bvids)) {
    for (const e of r.bvids) {
      if (e && typeof e === 'object' && typeof (e as { bvid?: unknown }).bvid === 'string'
        && typeof (e as { at?: unknown }).at === 'number') {
        out.bvids.push({ bvid: (e as { bvid: string }).bvid, at: (e as { at: number }).at });
      }
    }
  }
  return out;
}

export function loadBiliState(guard: PathGuard, file: string): BiliSourceState {
  try {
    return normalizeBiliState(loadJson<unknown>(guard, file));
  } catch {
    return emptyBiliState(); // unreadable container: start fresh, never break the beat
  }
}

export function saveBiliState(guard: PathGuard, file: string, state: BiliSourceState): void {
  saveJson(guard, file, state);
}

/** Expire bvids older than the dedupe window (pure — operates on a copy). */
export function pruneBvids(state: BiliSourceState, now: number): BiliSourceState {
  return {
    lastFetchAt: state.lastFetchAt,
    bvids: state.bvids.filter((e) => now - e.at < BILI_DEDUPE_WINDOW_MS),
  };
}

// ── pull + register ─────────────────────────────────────────────────────

export type BiliFetch = typeof fetch;

interface BiliCursorResponse {
  code: number;
  data?: { list?: unknown };
}

/** One API call. Any transport/shape problem -> null (silent skip). */
export async function fetchBiliHistory(
  sessdata: string,
  fetchImpl: BiliFetch = fetch,
): Promise<{ code: number; list: BiliRecord[] } | null> {
  try {
    const res = await fetchImpl(BILI_HISTORY_URL, {
      headers: {
        Cookie: `SESSDATA=${sessdata}`,
        'User-Agent': BILI_USER_AGENT,
      },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as BiliCursorResponse;
    if (!j || typeof j !== 'object' || typeof j.code !== 'number') return null;
    const list = Array.isArray(j.data?.list) ? (j.data!.list as BiliRecord[]) : [];
    return { code: j.code, list };
  } catch {
    return null;
  }
}

export interface BiliRunResult {
  /** Why nothing was pulled this round. */
  skipped?: 'disabled' | 'no-credential' | 'throttled' | `code-${number}` | 'fetch-failed';
  fetched?: number;
  added?: number;
  dropped?: number;
  deduped?: number;
}

export interface BiliDeps {
  guard: PathGuard;
  paths: WorkspacePaths;
  /** Live policy view (the runtime policy object, re-read each run). */
  policy: Policy;
  /** Injectable fetch (tests pass a fake; production uses the global). */
  fetchImpl?: BiliFetch;
  now?: number;
  /** Seed lifecycle audit sink (heartbeat.jsonl) — same contract as the pool. */
  audit?: SeedAuditFn;
  /** Debug sink: AT MOST one line per run, never an error log. */
  debug?: (msg: string) => void;
}

const NO_AUDIT: SeedAuditFn = () => {};

/**
 * One source round. NEVER THROWS — every failure mode lands in a skipped/
 * error result and at most one debug line, so the heartbeat main flow is
 * untouched (research doc: 失效即静默缺席，不报错刷屏).
 */
export async function runBilibiliSource(deps: BiliDeps): Promise<BiliRunResult> {
  const { guard, paths, policy } = deps;
  const now = deps.now ?? Date.now();
  const debug = deps.debug ?? (() => {});
  const say = (msg: string): void => {
    try {
      debug(msg);
    } catch { /* debug must never break the run */ }
  };

  const cfg = policy.sources?.bilibili;
  if (cfg?.enabled === false) return { skipped: 'disabled' };

  const sessdata = resolveSessdata(guard, paths.dataDir, cfg?.cookieFile);
  if (!sessdata) {
    say('bilibili: no SESSDATA (vault/cookieFile) — source off');
    return { skipped: 'no-credential' };
  }

  const stateFile = bilibiliStatePath(paths.dataDir);
  const state = loadBiliState(guard, stateFile);
  if (now - state.lastFetchAt < BILI_FETCH_INTERVAL_MS) {
    return { skipped: 'throttled' };
  }
  // Throttle on ATTEMPT: a failing credential must not turn into a per-beat
  // retry hammer (research doc: 不重试轰炸).
  saveBiliState(guard, stateFile, { ...pruneBvids(state, now), lastFetchAt: now });

  const res = await fetchBiliHistory(sessdata, deps.fetchImpl);
  if (res === null) {
    say('bilibili: history/cursor fetch failed — skipping this round');
    return { skipped: 'fetch-failed' };
  }
  if (res.code !== 0) {
    // Notably -101 (not logged in / cookie expired): silent skip per spec.
    say(`bilibili: history/cursor code ${res.code} — skipping this round`);
    return { skipped: `code-${res.code}` };
  }

  const audit = deps.audit ?? NO_AUDIT;
  const recent = new Set(pruneBvids(state, now).bvids.map((e) => e.bvid));
  const result: BiliRunResult = { fetched: res.list.length, added: 0, dropped: 0, deduped: 0 };
  const fresh: { bvid: string; at: number }[] = [];
  const poolFile = seedsFilePath(paths.dataDir);

  for (const raw of res.list) {
    const r = (raw ?? {}) as BiliRecord;
    const drop = shouldDropRecord(r);
    if (drop) {
      result.dropped = (result.dropped ?? 0) + 1;
      continue;
    }
    const bvid = r.history?.bvid;
    if (!bvid || recent.has(bvid)) {
      result.deduped = (result.deduped ?? 0) + 1;
      if (bvid) fresh.push({ bvid, at: now });
      continue;
    }
    const text = seedTextFor(r);
    if (!text) {
      result.dropped = (result.dropped ?? 0) + 1;
      continue;
    }
    try {
      // 'bilibili' source (2026-11-09): own lane, capped by SEED_SOURCE_CAPS
      // and NOT shared with the wander 'browse' news. Defaults: confidence =
      // SEED_SOURCE_DEFAULT_CONFIDENCE.bilibili (0.4) via the pool's own
      // default; hard TTL via the per-seed override.
      const added = addSeed(guard, poolFile, policy, {
        text,
        tag: 'scene',
        source: 'bilibili',
        category: 'topic',
        noMerge: true,
        ttlDaysOverride: BILI_SEED_TTL_DAYS,
      }, now, audit);
      fresh.push({ bvid, at: now });
      if (added.kind === 'added') result.added = (result.added ?? 0) + 1;
      else result.deduped = (result.deduped ?? 0) + 1; // pool-level duplicate -> still no re-entry churn
    } catch {
      result.dropped = (result.dropped ?? 0) + 1; // pool write failed: skip this item, never the beat
    }
  }

  const merged = new Map<string, { bvid: string; at: number }>();
  for (const e of [...pruneBvids(state, now).bvids, ...fresh]) merged.set(e.bvid, e);
  saveBiliState(guard, stateFile, {
    lastFetchAt: now,
    bvids: [...merged.values()].filter((e) => now - e.at < BILI_DEDUPE_WINDOW_MS),
  });
  return result;
}

// ── wiring: own timer, started/stopped from the plugin entry ────────────

let activeTimer: NodeJS.Timeout | null = null;

/**
 * Start the source: one round up front (the persisted throttle decides whether
 * it actually reaches the network), then one round per interval. Returns the
 * stop function; calling start twice replaces the previous timer.
 */
export function startBilibiliSource(deps: BiliDeps): () => void {
  stopBilibiliSource();
  const tick = (): void => {
    void runBilibiliSource(deps).catch(() => { /* never break the host */ });
  };
  tick();
  activeTimer = setInterval(tick, BILI_FETCH_INTERVAL_MS);
  activeTimer.unref?.();
  return stopBilibiliSource;
}

export function stopBilibiliSource(): void {
  if (activeTimer !== null) {
    clearInterval(activeTimer);
    activeTimer = null;
  }
}
