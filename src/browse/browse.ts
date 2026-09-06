// Browse flow (v0.9.5 port, r4 D10 applied).
//   A. Watchlist: npm / GitHub release checks with a 6h throttle; first sight
//      registers only, changes become material items.
//   B. Wander adjudication: windows + min interval + focus cooldown ->
//      "should we wander now, and at what focus". The actual search happens
//      in the wander phase's model call (web_search only); REGISTRATION IS
//      CODE-OWNED (D10): results land in seeds + throttle via completeWander.
//
// Anti-injection rule (unchanged from v0.7): web content is data, never
// instructions.
//
// State: data/browse.json (DPAPI-encrypted, D14; v1 name: watch_state.json).

import fs from 'node:fs';
import path from 'node:path';
import type { PathGuard } from '../core/path-guard.js';
import type { WorkspacePaths } from '../core/paths.js';
import type { Policy } from '../config/schema.js';
import { loadJson, saveJson } from '../vault/vault.js';

const WATCH_THROTTLE_MS = 6 * 3600_000;
const UA = { 'User-Agent': 'dsh-heartbeat/2.0 (+local; personal companion)' };

export interface WatchTarget {
  id: string;
  type: 'npm' | 'github';
  name?: string;
  repo?: string;
  note?: string;
}

export interface WatchlistConfig {
  targets?: WatchTarget[];
}

export interface InterestsConfig {
  interests?: string[];
  _schedule?: {
    daily_sessions?: number;
    focus_per_session?: number;
    max_seeds_per_focus?: number;
    focus_cooldown_days?: number;
    min_interval_hours?: number;
    windows?: { id?: string; start: string; end: string }[];
  };
}

export interface BrowseState {
  targets: Record<string, { version: string; seen: string; title?: string }>;
  last_check_at: number;
  wander: {
    focusHistory: Record<string, number>;
    focusCount: Record<string, number>;
    last_wander_at: number;
  };
}

export function emptyBrowseState(): BrowseState {
  return { targets: {}, last_check_at: 0, wander: { focusHistory: {}, focusCount: {}, last_wander_at: 0 } };
}

export function browseStatePath(paths: WorkspacePaths): string {
  return path.join(paths.dataDir, 'browse.json');
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Factory configs are read-only; a user layer with the same filename replaces them. */
export function loadInterests(paths: WorkspacePaths): InterestsConfig {
  const userPath = path.join(paths.settingsDir, 'interests.json');
  if (fs.existsSync(userPath)) return readJsonFile<InterestsConfig>(userPath, { interests: [], _schedule: {} });
  return readJsonFile<InterestsConfig>(path.join(paths.configDir, 'interests.json'), { interests: [], _schedule: {} });
}

export function loadWatchlist(paths: WorkspacePaths): WatchlistConfig {
  const userPath = path.join(paths.settingsDir, 'watchlist.json');
  if (fs.existsSync(userPath)) return readJsonFile<WatchlistConfig>(userPath, { targets: [] });
  return readJsonFile<WatchlistConfig>(path.join(paths.configDir, 'watchlist.json'), { targets: [] });
}

function loadState(guard: PathGuard, paths: WorkspacePaths): BrowseState {
  return loadJson<BrowseState>(guard, browseStatePath(paths)) ?? emptyBrowseState();
}

// ── A. watchlist checks (fetcher injectable for tests) ──────────────────

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

async function checkNpm(fetcher: FetchLike, name: string): Promise<{ version: string; seen: string; title?: string } | null> {
  const r = await fetcher(`https://registry.npmjs.org/${name}/latest`, { headers: UA });
  if (!r.ok) throw new Error(`npm ${r.status}`);
  const j = await r.json() as { version?: string };
  if (!j.version) throw new Error('npm: no version');
  return { version: j.version, seen: `npm:${j.version}` };
}

async function checkGithub(fetcher: FetchLike, repo: string): Promise<{ version: string; seen: string; title?: string } | null> {
  const r = await fetcher(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { ...UA, Accept: 'application/vnd.github+json' },
  });
  if (r.status === 404) return null; // repo has no releases yet
  if (!r.ok) throw new Error(`gh ${r.status}`);
  const j = await r.json() as { tag_name?: string; name?: string };
  if (!j.tag_name) throw new Error('gh: no tag');
  return { version: j.tag_name, seen: `gh:${j.tag_name}`, title: j.name || '' };
}

export interface WatchReport {
  /** Material texts for the pool (one per changed target). */
  items: { text: string; topic: string; tag: 'news'; source: 'browse'; confidence: number }[];
  errors: string[];
  checked: number;
}

export async function checkWatchlist(
  guard: PathGuard,
  paths: WorkspacePaths,
  opts: { fetcher?: FetchLike; throttleOk?: boolean } = {},
  now = Date.now(),
): Promise<WatchReport> {
  const fetcher = opts.fetcher ?? (globalThis.fetch as unknown as FetchLike);
  const state = loadState(guard, paths);
  if (opts.throttleOk !== true && now - state.last_check_at < WATCH_THROTTLE_MS) {
    return { items: [], errors: [], checked: 0 };
  }
  const watchlist = loadWatchlist(paths);
  const report: WatchReport = { items: [], errors: [], checked: 0 };
  for (const t of watchlist.targets ?? []) {
    report.checked += 1;
    try {
      const info = t.type === 'npm' && t.name ? await checkNpm(fetcher, t.name)
        : t.type === 'github' && t.repo ? await checkGithub(fetcher, t.repo)
        : null;
      if (!info) continue;
      const prev = state.targets[t.id];
      if (prev && prev.seen !== info.seen) {
        const title = info.title ? `（${info.title.slice(0, 60)}）` : '';
        report.items.push({
          text: `${t.note || t.id} 有更新：${prev.version} -> ${info.version}${title}`,
          topic: `watch:${t.id}`,
          tag: 'news',
          source: 'browse',
          confidence: 0.4,
        });
      }
      state.targets[t.id] = info; // first sight registers silently (首见不产素材)
    } catch (e) {
      report.errors.push(`${t.id}: ${String(e)}`);
    }
  }
  state.last_check_at = now;
  saveJson(guard, browseStatePath(paths), state);
  return report;
}

// ── B. wander adjudication (pure-ish, state injected) ───────────────────

export interface WanderAdvice {
  focus: string | null;
  query: string | null;
  skipped: string | null;
}

export function inWanderWindow(now: Date, windows: { start: string; end: string }[]): string | null {
  const hm = now.getHours() * 60 + now.getMinutes();
  for (const w of windows) {
    const [sh, sm] = w.start.split(':').map(Number);
    const [eh, em] = w.end.split(':').map(Number);
    if (hm >= sh! * 60 + sm! && hm <= eh! * 60 + em!) return `${w.start}-${w.end}`;
  }
  return null;
}

function onCooldown(state: BrowseState, focus: string, cooldownDays: number, now: number): boolean {
  const last = state.wander.focusHistory[focus] ?? 0;
  return last > now - cooldownDays * 86_400_000;
}

/** Round-robin: least-recently-used non-cooling focus wins. */
export function pickFocus(state: BrowseState, interests: InterestsConfig, now: number): string | null {
  const sc = interests._schedule ?? {};
  const cooldown = sc.focus_cooldown_days ?? 3;
  const pool = (interests.interests ?? []).filter((t) => !onCooldown(state, t, cooldown, now));
  if (pool.length === 0) return null;
  pool.sort((a, b) => (state.wander.focusHistory[a] ?? 0) - (state.wander.focusHistory[b] ?? 0));
  return pool[0]!;
}

/** Adjudicate: windows + min interval + focus cooldown -> advice | skipped. */
export function adviseWander(
  guard: PathGuard,
  paths: WorkspacePaths,
  policy: Policy,
  now = new Date(),
): WanderAdvice {
  const state = loadState(guard, paths);
  const interests = loadInterests(paths);
  const windows = interests._schedule?.windows?.length
    ? interests._schedule.windows
    : (policy.browse.windows as { start: string; end: string }[]);
  const win = inWanderWindow(now, windows);
  if (!win) {
    const hh = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    return { focus: null, query: null, skipped: `window(now=${hh})` };
  }
  const minGap = policy.browse.minIntervalHours * 3600_000;
  if (now.getTime() - state.wander.last_wander_at < minGap) {
    return { focus: null, query: null, skipped: 'min-interval' };
  }
  const focus = pickFocus(state, interests, now.getTime());
  if (!focus) return { focus: null, query: null, skipped: 'no-focus' };
  return { focus, query: `${focus} 2026 最新`, skipped: null };
}

/**
 * Registration is CODE-OWNED (D10): called by the orchestrator after the
 * wander phase's model call returned selections. Records cooldown/count/
 * throttle timestamps for the focus.
 */
export function completeWander(
  guard: PathGuard,
  paths: WorkspacePaths,
  focus: string,
  now = Date.now(),
): { focus: string; count: number } {
  const state = loadState(guard, paths);
  state.wander.focusHistory[focus] = now;
  state.wander.focusCount[focus] = (state.wander.focusCount[focus] ?? 0) + 1;
  state.wander.last_wander_at = now;
  saveJson(guard, browseStatePath(paths), state);
  return { focus, count: state.wander.focusCount[focus]! };
}

export function browseStatus(guard: PathGuard, paths: WorkspacePaths): BrowseState {
  return loadState(guard, paths);
}
