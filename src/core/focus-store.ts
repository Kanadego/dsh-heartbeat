// Focus-mode persistence (v2.1.0 ①).
//
// THE BUG THIS FILE EXISTS FOR: `pauseFocus()`/resumeFocus()` are module state,
// and the operational CLI runs as its OWN process (`node dist/cli/index.js`),
// so a pause set there never reached the host's orchestrator. The pause now
// lives in `data/focus.json`: the CLI writes it, the host reads it at the top
// of every beat, and the RPC/settings-card path keeps both copies in sync
// (module state = immediate, file = cross-process and survives a restart).
//
// The file is deliberately NOT cleared at startup: a pause that outlives a
// restart is what a debugging session actually wants, and the status line
// always names the lift time ("专注模式 · 至 HH:MM"), so it is never invisible.

import fs from 'node:fs';
import path from 'node:path';
import type { PathGuard } from './path-guard.js';
import type { WorkspacePaths } from './paths.js';
import { atomicWriteJsonSync } from './atomic-fs.js';

export interface FocusState {
  /** Epoch ms when the pause lifts. */
  until: number;
  /** Requested minutes (clamped 1-1440). */
  minutes: number;
  /** Epoch ms when it was set. */
  since: number;
  /** Who set it: 'cli' | 'rpc' | 'settings-card' | ... */
  via: string;
}

export const FOCUS_MIN_MINUTES = 1;
export const FOCUS_MAX_MINUTES = 1440;

export function focusStatePath(paths: WorkspacePaths): string {
  return path.join(paths.dataDir, 'focus.json');
}

/** The pause as stored on disk, or null when absent / malformed / already expired. */
export function readFocusState(guard: PathGuard, paths: WorkspacePaths, now = Date.now()): FocusState | null {
  try {
    const raw = fs.readFileSync(guard.assert(focusStatePath(paths)), 'utf8');
    const parsed = JSON.parse(raw) as Partial<FocusState>;
    const until = Number(parsed.until);
    if (!Number.isFinite(until) || until <= now) return null;
    return {
      until,
      minutes: Number(parsed.minutes) || 0,
      since: Number(parsed.since) || 0,
      via: String(parsed.via ?? 'unknown'),
    };
  } catch {
    return null; // missing, unparsable, or outside the guard: "no pause"
  }
}

export function writeFocusState(
  guard: PathGuard,
  paths: WorkspacePaths,
  minutes: number,
  now = Date.now(),
  via = 'cli',
): FocusState {
  const m = Math.max(FOCUS_MIN_MINUTES, Math.min(FOCUS_MAX_MINUTES, Math.floor(minutes)));
  const state: FocusState = { until: now + m * 60_000, minutes: m, since: now, via };
  atomicWriteJsonSync(guard.assert(focusStatePath(paths)), state);
  return state;
}

/** Lift the on-disk pause; true when a file was actually removed. */
export function clearFocusState(guard: PathGuard, paths: WorkspacePaths): boolean {
  try {
    const file = guard.assert(focusStatePath(paths));
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** The effective pause instant for a beat: the OR of module state and disk.
 *  A beat that starts before this returns considers itself paused. */
export function resolveFocusUntil(guard: PathGuard, paths: WorkspacePaths, memoryUntil: number, now = Date.now()): number {
  const file = readFocusState(guard, paths, now)?.until ?? 0;
  return Math.max(memoryUntil > now ? memoryUntil : 0, file);
}
