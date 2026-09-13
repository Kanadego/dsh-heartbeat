// Interest-scope editing for the settings card (v1.4.0).
//
// The wander adjudicator picks its focus from `interests.json` (browse.ts
// `loadInterests`): the factory copy in config/ is read-only, and a user layer
// at data/settings/interests.json REPLACES it wholesale. That replace-not-merge
// semantics is why every successful edit funnels through `ensureUserLayer`: the
// FIRST edit copies the factory file (interests + _schedule, verbatim) into the
// user layer before applying the change, so the card becomes the single
// management entry point without silently dropping the other factory rows.
// Reads and FAILED validations stay read-only (`readEffective`) — merely
// opening the card must not take the user layer over.
//
// All writes stay inside the guard; unknown top-level keys (e.g. _comment) are
// preserved on save so hand-written annotations survive card edits.

import fs from 'node:fs';
import path from 'node:path';
import type { PathGuard } from '../core/path-guard.js';
import type { WorkspacePaths } from '../core/paths.js';

/** Mirrors browse.ts's InterestsConfig; kept local so this module owns the
 * editing shape (windows gain mandatory ids on save). */
export interface InterestsDoc {
  interests: string[];
  _schedule?: {
    daily_sessions?: number;
    focus_per_session?: number;
    max_seeds_per_focus?: number;
    focus_cooldown_days?: number;
    min_interval_hours?: number;
    windows?: { id?: string; start: string; end: string }[];
  };
  [key: string]: unknown;
}

export interface WanderWindow {
  id: string;
  start: string;
  end: string;
}

export const MAX_INTERESTS = 32;
export const MAX_INTEREST_LEN = 60;
const MAX_WINDOWS = 6;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function userInterestsPath(paths: WorkspacePaths): string {
  return path.join(paths.settingsDir, 'interests.json');
}

export function factoryInterestsPath(paths: WorkspacePaths): string {
  return path.join(paths.configDir, 'interests.json');
}

function readDoc(file: string): InterestsDoc | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<InterestsDoc>;
    if (!Array.isArray(raw.interests)) return null;
    return { ...raw, interests: raw.interests.map(String) };
  } catch {
    return null;
  }
}

/** What the wander adjudicator sees right now — WITHOUT creating the user
 * layer. Fallback chain: user layer -> factory -> empty. */
export function readEffective(paths: WorkspacePaths): InterestsDoc {
  return (
    readDoc(userInterestsPath(paths)) ??
    readDoc(factoryInterestsPath(paths)) ?? { interests: [] }
  );
}

/**
 * The user layer, created on first EDIT by copying the factory file verbatim
 * (decision: 首编继承出厂). Call only from mutation paths that are about to
 * succeed; the doc it returns equals `readEffective` at call time.
 */
export function ensureUserLayer(guard: PathGuard, paths: WorkspacePaths): InterestsDoc {
  const existing = readDoc(userInterestsPath(paths));
  if (existing) return existing;
  const doc: InterestsDoc = readDoc(factoryInterestsPath(paths)) ?? { interests: [] };
  saveDoc(guard, userInterestsPath(paths), doc);
  return doc;
}

function saveDoc(guard: PathGuard, file: string, doc: InterestsDoc): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(guard.assert(file), JSON.stringify(doc, null, 2), 'utf8');
}

export interface InterestsResult {
  ok: boolean;
  reason?: string;
  doc: InterestsDoc;
}

/** Normalize: trim + collapse internal whitespace. Case-insensitive dedupe. */
export function normalizeInterest(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export function addInterest(
  guard: PathGuard,
  paths: WorkspacePaths,
  rawText: string,
): InterestsResult {
  const text = normalizeInterest(rawText);
  if (!text) return { ok: false, reason: 'empty', doc: readEffective(paths) };
  if (text.length > MAX_INTEREST_LEN) {
    return { ok: false, reason: `too-long (max ${MAX_INTEREST_LEN})`, doc: readEffective(paths) };
  }
  const current = readEffective(paths);
  if (current.interests.some((t) => normalizeInterest(t).toLowerCase() === text.toLowerCase())) {
    return { ok: false, reason: 'duplicate', doc: current };
  }
  if (current.interests.length >= MAX_INTERESTS) {
    return { ok: false, reason: `cap (${MAX_INTERESTS})`, doc: current };
  }
  const doc = ensureUserLayer(guard, paths);
  doc.interests.push(text);
  saveDoc(guard, userInterestsPath(paths), doc);
  return { ok: true, doc };
}

export function removeInterest(
  guard: PathGuard,
  paths: WorkspacePaths,
  rawText: string,
): InterestsResult {
  const current = readEffective(paths);
  const text = normalizeInterest(rawText);
  if (!current.interests.some((t) => normalizeInterest(t) === text)) {
    return { ok: false, reason: 'not-found', doc: current };
  }
  const doc = ensureUserLayer(guard, paths);
  doc.interests = doc.interests.filter((t) => normalizeInterest(t) !== text);
  saveDoc(guard, userInterestsPath(paths), doc);
  return { ok: true, doc };
}

/** Validate "HH:MM" and same-day ordering (the wander windows are intra-day). */
export function parseWindow(w: unknown): { ok: true; window: WanderWindow } | { ok: false; reason: string } {
  if (typeof w !== 'object' || w === null) return { ok: false, reason: 'not-an-object' };
  const { id, start, end } = w as { id?: unknown; start?: unknown; end?: unknown };
  if (typeof start !== 'string' || !HHMM.test(start)) return { ok: false, reason: `bad start ${JSON.stringify(start)}` };
  if (typeof end !== 'string' || !HHMM.test(end)) return { ok: false, reason: `bad end ${JSON.stringify(end)}` };
  if (start >= end) return { ok: false, reason: `start ${start} must be before end ${end}` };
  return { ok: true, window: { id: typeof id === 'string' && id ? id : `${start}-${end}`, start, end } };
}

/** Full-state write of the wander windows (the card sends all rows each time). */
export function setWanderWindows(
  guard: PathGuard,
  paths: WorkspacePaths,
  rawWindows: unknown,
): InterestsResult {
  const fail = (reason: string): InterestsResult => ({ ok: false, reason, doc: readEffective(paths) });
  if (!Array.isArray(rawWindows)) return fail('windows-must-be-array');
  if (rawWindows.length === 0) return fail('at-least-one-window');
  if (rawWindows.length > MAX_WINDOWS) return fail(`cap (${MAX_WINDOWS})`);
  const windows: WanderWindow[] = [];
  for (const raw of rawWindows) {
    const parsed = parseWindow(raw);
    if (!parsed.ok) return fail(parsed.reason);
    windows.push(parsed.window);
  }
  // Overlap check: the adjudicator returns the FIRST matching window, so
  // overlapping rows would silently change which window "wins".
  const sorted = [...windows].sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]!.start < sorted[i - 1]!.end) {
      return fail(`windows overlap: ${sorted[i - 1]!.id} / ${sorted[i]!.id}`);
    }
  }
  const doc = ensureUserLayer(guard, paths);
  doc._schedule = { ...doc._schedule, windows };
  saveDoc(guard, userInterestsPath(paths), doc);
  return { ok: true, doc };
}
