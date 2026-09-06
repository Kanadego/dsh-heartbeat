// Environment thermometer (v0.9 port). Signal: keyboard/mouse idle seconds
// (idle.ps1) + foreground window class. A thermometer, not a trigger - used to
// tune tone and defer interruptions, never to startle.
//
// v2 charter note (A3): envpulse.json stays PLAINTEXT (aggregate stats only),
// so it stores NO foreground process/title - those live in encrypted
// screen.json. v1 stored fg_process here; dropped as hardening.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendAuditLine } from '../core/audit-log.js';
import { timeContext } from './timeflow.js';
import { classifyProcess, type BusyRules } from '../gate/busy-rules.js';
import type { PathGuard } from '../core/path-guard.js';
import type { WorkspacePaths } from '../core/paths.js';

export const IDLE_AWAY_SECONDS = 1200; // >= 20 min: away or watching (screen fallback distinguishes)
export const IDLE_FLOOR_SECONDS = 30;  // < 30s: typing; busy/idle decided by window class

export type Presence = 'unknown' | 'away' | 'present' | 'active';

export function presenceOf(idleSec: number, windowClass: string): Presence {
  if (idleSec < 0) return 'unknown';
  if (idleSec >= IDLE_AWAY_SECONDS) return 'away';
  if (idleSec >= IDLE_FLOOR_SECONDS) return 'present';
  return windowClass === 'busy' ? 'active' : 'present';
}

export interface EnvSnapshot {
  takenAt: string;
  idleSeconds: number;
  presence: Presence;
  windowClass: 'busy' | 'idle' | 'unknown';
  daypart: string;
  weekday: string;
  isWeekend: boolean;
  festival: string | null;
}

function probeIdle(guard: PathGuard, paths: WorkspacePaths): number {
  const tmp = path.join(paths.tmpDir, `idle-${Date.now()}.txt`);
  try {
    const out = guard.assert(tmp);
    const r = spawnSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(paths.assetsDir, 'idle.ps1'), '-out', out],
      { timeout: 20_000, encoding: 'utf8' });
    if (r.status !== 0 || !fs.existsSync(out)) return -1;
    const v = Number.parseInt(fs.readFileSync(out, 'utf8').trim(), 10);
    return Number.isNaN(v) ? -1 : v;
  } catch {
    return -1;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Refresh the thermometer snapshot. `fgProcess` comes from the same beat's
 * screen pulse when available (orchestrator order: screen first, then env).
 */
export function collectPulse(
  guard: PathGuard,
  paths: WorkspacePaths,
  rules: BusyRules,
  fgProcess: string | null = null,
  now = new Date(),
): EnvSnapshot {
  const idle = probeIdle(guard, paths);
  const windowClass = classifyProcess(fgProcess, rules);
  const t = timeContext(now);
  const snapshot: EnvSnapshot = {
    takenAt: now.toISOString(),
    idleSeconds: idle,
    presence: presenceOf(idle, windowClass),
    windowClass,
    daypart: t.daypart,
    weekday: t.weekday,
    isWeekend: t.isWeekend,
    festival: t.festival,
  };
  try {
    fs.writeFileSync(path.join(paths.dataDir, 'envpulse.json'), JSON.stringify(snapshot, null, 1), 'utf8');
  } catch {
    // thermometer failure must not block the heartbeat
  }
  // v1.1 (§12 #3): append the raw pulse to the streaming log. Retention
  // (envPulseHours) is pruned by the maintenance phase; the stream is plaintext
  // like envpulse.json (aggregate stats only, no window titles/process names).
  writePulseStream(paths, snapshot);
  return snapshot;
}

/**
 * Append one pulse to the streaming log (logs/envpulse.jsonl). Pure side
 * effect; failures must never block the heartbeat (caller contract).
 */
export function writePulseStream(paths: WorkspacePaths, snapshot: EnvSnapshot): void {
  try {
    appendAuditLine(path.join(paths.logsDir, 'envpulse.jsonl'), {
      event: 'pulse',
      takenAt: snapshot.takenAt,
      idleSeconds: snapshot.idleSeconds,
      presence: snapshot.presence,
      windowClass: snapshot.windowClass,
      daypart: snapshot.daypart,
      weekday: snapshot.weekday,
      isWeekend: snapshot.isWeekend,
      festival: snapshot.festival,
    });
  } catch {
    // stream append failure must not block the heartbeat
  }
}

/** Read the latest persisted snapshot (no probing). */
export function readPulse(guard: PathGuard, paths: WorkspacePaths): EnvSnapshot | null {
  try {
    const raw = fs.readFileSync(path.join(paths.dataDir, 'envpulse.json'), 'utf8');
    return JSON.parse(raw) as EnvSnapshot;
  } catch {
    return null;
  }
}
