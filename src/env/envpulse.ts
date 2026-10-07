// Environment thermometer (v0.9 port). Signal: keyboard/mouse idle seconds
// (idle.ps1) + foreground window class. A thermometer, not a trigger - used to
// tune tone and defer interruptions, never to startle.
//
// v2 charter note (A3): envpulse.json stays PLAINTEXT (aggregate stats only),
// so it stores NO foreground process/title - those live in encrypted
// screen.json. v1 stored fg_process here; dropped as hardening.

import fs from 'node:fs';
import path from 'node:path';
import { runPowerShell, runPowerShellFile } from '../core/ps.js';
import { appendAuditLine } from '../core/audit-log.js';
import { timeContext } from './timeflow.js';
import { classifyProcess, type BusyRules } from '../gate/busy-rules.js';
import type { PathGuard } from '../core/path-guard.js';
import type { WorkspacePaths } from '../core/paths.js';

export const IDLE_AWAY_SECONDS = 1200; // >= 20 min: away or watching (screen fallback distinguishes)
export const IDLE_FLOOR_SECONDS = 30;  // < 30s: typing; busy/idle decided by window class

export type Presence = 'unknown' | 'away' | 'present' | 'active';

/**
 * H-68 (2026-10-07): the thresholds live in `busy-rules.json`'s `rules` block;
 * the exported constants remain as the fallback so callers without a rules
 * object keep their old behaviour.
 */
export function presenceOf(idleSec: number, windowClass: string, rules?: BusyRules): Presence {
  const awayAfter = rules?.rules.idle_away_seconds ?? IDLE_AWAY_SECONDS;
  const floorAt = rules?.rules.idle_floor_seconds ?? IDLE_FLOOR_SECONDS;
  if (idleSec < 0) return 'unknown';
  if (idleSec >= awayAfter) return 'away';
  if (idleSec >= floorAt) return 'present';
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

async function probeIdle(guard: PathGuard, paths: WorkspacePaths): Promise<number> {
  const tmp = path.join(paths.tmpDir, `idle-${Date.now()}.txt`);
  try {
    const out = guard.assert(tmp);
    const r = await runPowerShellFile(path.join(paths.assetsDir, 'idle.ps1'), ['-out', out], 20_000);
    if (r.status !== 0 || !fs.existsSync(out)) return -1;
    const v = Number.parseInt(fs.readFileSync(out, 'utf8').trim(), 10);
    return Number.isNaN(v) ? -1 : v;
  } catch {
    return -1;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Exported for the token-saver gate (v1.7.0): fresh idle seconds on demand. */
export async function probeIdleSeconds(guard: PathGuard, paths: WorkspacePaths): Promise<number> {
  return probeIdle(guard, paths);
}

/**
 * Workstation lock probe (token-saver, v1.7.0): LogonUI.exe only runs while
 * the Windows session is locked. Probe failure fails OPEN (false = unlocked)
 * so a broken probe never pauses the heartbeat by itself.
 */
export async function probeWorkstationLocked(): Promise<boolean> {
  const r = await runPowerShell(
    ['-Command', 'if (Get-Process -Name LogonUI -ErrorAction SilentlyContinue) { "locked" } else { "unlocked" }'],
    10_000,
  );
  return r.status === 0 && String(r.stdout || '').includes('locked');
}

/**
 * Refresh the thermometer snapshot. `fgProcess` comes from the same beat's
 * screen pulse when available (orchestrator order: screen first, then env).
 */
export async function collectPulse(
  guard: PathGuard,
  paths: WorkspacePaths,
  rules: BusyRules,
  fgProcess: string | null = null,
  now = new Date(),
): Promise<EnvSnapshot> {
  const idle = await probeIdle(guard, paths);
  const windowClass = classifyProcess(fgProcess, rules);
  const t = timeContext(now);
  const snapshot: EnvSnapshot = {
    takenAt: now.toISOString(),
    idleSeconds: idle,
    presence: presenceOf(idle, windowClass, rules),
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
