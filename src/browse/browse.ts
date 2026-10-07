// Browse flow (v0.9.5 port, r4 D10 applied).
//   Wander adjudication: windows + min interval + focus cooldown ->
//      "should we wander now, and at what focus". The actual search happens
//      in the wander phase's model call (web_search only); REGISTRATION IS
//      CODE-OWNED (D10): results land in seeds + throttle via completeWander.
//
// H-12 (2026-10-07): the npm/GitHub watchlist check was removed. It never ran
// inside the beat (only `browse watch` in the CLI called it, throttled-off),
// and "is DSH itself updated" is not this plugin's job to track.
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
import { inHhMmWindow, minutesOfDay } from '../core/time-window.js';
import { loadJson, saveJson } from '../vault/vault.js';
import { activeSeeds, loadPool, normalizeCategory, seedsFilePath } from '../seeds/pool.js';
import { loadPreference, preferenceFilePath, preferenceWeight, type PrefState } from './preference.js';

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
  wander: {
    focusHistory: Record<string, number>;
    focusCount: Record<string, number>;
    last_wander_at: number;
    /** Spec ⑥: refill wanders per LOCAL day, e.g. "2026-09-18" -> 1. */
    refillCount?: Record<string, number>;
  };
}

export function emptyBrowseState(): BrowseState {
  return { wander: { focusHistory: {}, focusCount: {}, last_wander_at: 0, refillCount: {} } };
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

/**
 * H-65: the state file outlives upgrades and is hand-inspectable, so a row
 * missing a field must not throw its way into a `beat_error` on every beat.
 * Garbage values are dropped back to the empty-state defaults.
 */
export function normalizeBrowseState(raw: unknown): BrowseState {
  const out = emptyBrowseState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Partial<BrowseState>;
  const w = (r.wander && typeof r.wander === 'object' ? r.wander : {}) as Partial<BrowseState['wander']>;
  out.wander.focusHistory = numberRecord(w.focusHistory);
  out.wander.focusCount = numberRecord(w.focusCount);
  out.wander.refillCount = numberRecord(w.refillCount);
  if (typeof w.last_wander_at === 'number' && Number.isFinite(w.last_wander_at)) out.wander.last_wander_at = w.last_wander_at;
  return out;
}

function numberRecord(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (typeof n === 'number' && Number.isFinite(n)) out[k] = n;
  }
  return out;
}

function loadState(guard: PathGuard, paths: WorkspacePaths): BrowseState {
  return normalizeBrowseState(loadJson<unknown>(guard, browseStatePath(paths)));
}

// ── B. wander adjudication (pure-ish, state injected) ───────────────────

export interface WanderAdvice {
  focus: string | null;
  query: string | null;
  skipped: string | null;
}

export function inWanderWindow(now: Date, windows: { start: string; end: string }[]): string | null {
  const mins = minutesOfDay(now);
  for (const w of windows) {
    if (inHhMmWindow(w.start, w.end, mins)) return `${w.start}-${w.end}`;
  }
  return null;
}

function onCooldown(state: BrowseState, focus: string, cooldownDays: number, now: number): boolean {
  const last = state.wander.focusHistory[focus] ?? 0;
  return last > now - cooldownDays * 86_400_000;
}

/**
 * Focus pick (2026-10-06): round-robin recency as the base, preference rate as
 * a multiplier. Ordering key = effective age = realAgeSinceLastUse × weight —
 * a favorite's age "grows" faster, so it reaches the pick threshold sooner and
 * is wandered up to W_MAX times as often. Lockdown-proof by construction:
 *   - cooldown (above) keeps every topic rotating no matter the weight;
 *   - weight lives in [W_MIN, W_MAX] (preference.ts);
 *   - hard starvation floor: any topic untouched ≥ STARVATION_DAYS ignores
 *     weighting entirely and the oldest real age wins.
 * Without a preference state the behavior is exactly the old pure LRU.
 */
export const STARVATION_DAYS = 14;

export function pickFocus(
  state: BrowseState,
  interests: InterestsConfig,
  now: number,
  pref?: PrefState,
): string | null {
  const sc = interests._schedule ?? {};
  const cooldown = sc.focus_cooldown_days ?? 3;
  const pool = (interests.interests ?? []).filter((t) => !onCooldown(state, t, cooldown, now));
  if (pool.length === 0) return null;
  if (!pref) {
    pool.sort((a, b) => (state.wander.focusHistory[a] ?? 0) - (state.wander.focusHistory[b] ?? 0));
    return pool[0]!;
  }
  const age = (t: string): number => now - (state.wander.focusHistory[t] ?? 0);
  const starved = pool.filter((t) => age(t) >= STARVATION_DAYS * 86_400_000);
  if (starved.length > 0) {
    starved.sort((a, b) => age(b) - age(a)); // oldest real age wins
    return starved[0]!;
  }
  const effAge = (t: string): number => age(t) * preferenceWeight(pref, t, now);
  pool.sort((a, b) => effAge(b) - effAge(a));
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
  const focus = pickFocus(state, interests, now.getTime(), loadPreference(guard, preferenceFilePath(paths.dataDir)));
  if (!focus) return { focus: null, query: null, skipped: 'no-focus' };
  return { focus, query: `${focus} 2026 最新`, skipped: null };
}

/**
 * Registration is CODE-OWNED (D10): called by the orchestrator after the
 * wander phase's model call returned selections. Records cooldown/count/
 * throttle timestamps for the focus. `refill` additionally bumps the daily
 * refill counter (spec ⑥).
 */
export function completeWander(
  guard: PathGuard,
  paths: WorkspacePaths,
  focus: string,
  now = Date.now(),
  opts: { refill?: boolean } = {},
): { focus: string; count: number; refillsToday?: number } {
  const state = loadState(guard, paths);
  state.wander.focusHistory[focus] = now;
  state.wander.focusCount[focus] = (state.wander.focusCount[focus] ?? 0) + 1;
  state.wander.last_wander_at = now;
  let refillsToday: number | undefined;
  if (opts.refill) {
    const today = localDayKey(new Date(now));
    state.wander.refillCount = state.wander.refillCount ?? {};
    state.wander.refillCount[today] = (state.wander.refillCount[today] ?? 0) + 1;
    refillsToday = state.wander.refillCount[today];
  }
  saveJson(guard, browseStatePath(paths), state);
  return { focus, count: state.wander.focusCount[focus]!, ...(refillsToday === undefined ? {} : { refillsToday }) };
}

/** LOCAL day key (refill quota is a daily human-day budget, not a UTC day). */
function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── C. refill wander (spec ⑥, 2026-09-18): top up topic stock when it runs
// dry. Independent of the window/minInterval gates (user decision: may stack
// with a normal wander in the same beat) but still respects the 3-day focus
// cooldown, and is capped at REFILL_MAX_PER_DAY per local day.

export const REFILL_TOPIC_THRESHOLD = 4;
export const REFILL_MAX_PER_DAY = 2;

export interface RefillAdvice {
  focus: string | null;
  query: string | null;
  skipped: string | null;
  topicCount: number;
  refillsToday: number;
}

export function adviseRefillWander(
  guard: PathGuard,
  paths: WorkspacePaths,
  policy: Policy,
  now = new Date(),
): RefillAdvice {
  const state = loadState(guard, paths);
  const today = localDayKey(now);
  const refillsToday = state.wander.refillCount?.[today] ?? 0;
  const topicCount = activeSeeds(loadPool(guard, seedsFilePath(paths.dataDir)))
    .filter((s) => normalizeCategory(s.category) === 'topic').length;
  if (refillsToday >= REFILL_MAX_PER_DAY) {
    return { focus: null, query: null, skipped: `refill-daily-cap(${refillsToday})`, topicCount, refillsToday };
  }
  if (topicCount > REFILL_TOPIC_THRESHOLD) {
    return { focus: null, query: null, skipped: `topic-stock-ok(${topicCount})`, topicCount, refillsToday };
  }
  const interests = loadInterests(paths);
  const focus = pickFocus(state, interests, now.getTime(), loadPreference(guard, preferenceFilePath(paths.dataDir))); // 3-day cooldown still applies
  if (!focus) {
    return { focus: null, query: null, skipped: 'no-focus', topicCount, refillsToday };
  }
  return { focus, query: `${focus} 2026 最新`, skipped: null, topicCount, refillsToday };
}

export function browseStatus(guard: PathGuard, paths: WorkspacePaths): BrowseState {
  return loadState(guard, paths);
}
