// M7a: heartbeat presence status store (design doc §17.3).
//
// The engine-room beat derives one scene-level status per beat and writes it
// here; the statusbar tracks (M7c) read it to render the daily-session status.
// Per D21 the store NEVER carries time words — scenes only. Plaintext on disk
// (scene enum + one short note; no user-identifying content, same line as
// envpulse in D14 §10.5).

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJsonSync } from '../core/atomic-fs.js';
import type { PathGuard } from '../core/path-guard.js';
import type { WorkspacePaths } from '../core/paths.js';

/** Scene enum (§17.3): quiet-hours > just-spoke > wandering > busy > present > away. */
export type StatusScene =
  | 'quiet-hours'
  | 'just-spoke'
  | 'wandering'
  | 'busy'
  | 'present'
  | 'away';

export interface StatusState {
  /** ISO timestamp of the beat that wrote this state. */
  at: string;
  scene: StatusScene;
  /** One short engine-room note (≤30 chars), may be absent. */
  note?: string;
}

/** The scene priority used by {@link deriveScene}: first match wins. */
const SCENE_PRIORITY: readonly StatusScene[] = [
  'quiet-hours',
  'just-spoke',
  'wandering',
  'busy',
  'present',
  'away',
];

export interface SceneInputs {
  quietHours: boolean;
  /** The beat just spoke (this beat's verdict === 'spoke'). */
  spokeThisBeat: boolean;
  /** The beat just ran a wander search that returned material. */
  wanderedThisBeat: boolean;
  /** envpulse presence of the user right now. */
  presence: 'active' | 'present' | 'idle' | 'away' | 'unknown';
}

/** Pure scene derivation (§17.3) — deterministic, unit-tested matrix. */
export function deriveScene(input: SceneInputs): StatusScene {
  if (input.quietHours) return 'quiet-hours';
  if (input.spokeThisBeat) return 'just-spoke';
  if (input.wanderedThisBeat) return 'wandering';
  if (input.presence === 'active') return 'busy';
  if (input.presence === 'away') return 'away';
  return 'present';
}

/** Clamp a free-form note into the ≤30-char store invariant. */
export function clampNote(note: string | undefined): string | undefined {
  const t = (note ?? '').trim();
  if (!t) return undefined;
  return t.length <= 30 ? t : t.slice(0, 30);
}

export function statusFilePath(dataDir: string): string {
  return path.join(dataDir, 'settings', 'status.json');
}

export function writeStatus(guard: PathGuard, paths: WorkspacePaths, state: StatusState): void {
  atomicWriteJsonSync(guard.assert(statusFilePath(paths.dataDir)), state);
}

export function readStatus(guard: PathGuard, paths: WorkspacePaths): StatusState | null {
  try {
    const raw = fs.readFileSync(guard.assert(statusFilePath(paths.dataDir)), 'utf8');
    const parsed = JSON.parse(raw) as StatusState;
    if (typeof parsed?.at !== 'string' || typeof parsed?.scene !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * mtime-cached reader for the injection tracks (M7c): the section variable /
 * pre-step listener runs on EVERY step of EVERY bound session — this keeps the
 * hot path at one stat() instead of a full file read + JSON.parse.
 */
export class StatusReader {
  private mtimeMs = -1;
  private size = -1;
  private cached: StatusState | null = null;

  read(guard: PathGuard, paths: WorkspacePaths): StatusState | null {
    const file = statusFilePath(paths.dataDir);
    let st: fs.Stats;
    try {
      st = fs.statSync(guard.assert(file));
    } catch {
      this.mtimeMs = -1;
      this.cached = null;
      return null;
    }
    if (st.mtimeMs === this.mtimeMs && st.size === this.size) return this.cached;
    this.mtimeMs = st.mtimeMs;
    this.size = st.size;
    this.cached = readStatus(guard, paths);
    return this.cached;
  }
}
