// Windows toast channel (D12): attention hint ONLY - never carries the
// expression body. Wraps assets/notify.ps1 (self-registering AUMID).

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { WorkspacePaths } from '../core/paths.js';

function runNotify(paths: WorkspacePaths, args: string[]): { status: number; out: string } {
  const r = spawnSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(paths.assetsDir, 'notify.ps1'), ...args],
    { timeout: 20_000, encoding: 'utf8' });
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/** Register the toast identity if missing (idempotent, per machine/user). */
export function ensureRegistered(paths: WorkspacePaths): boolean {
  const check = runNotify(paths, ['-Check']);
  if (/REGISTERED: yes/.test(check.out)) return true;
  const reg = runNotify(paths, ['-RegisterOnly']);
  return reg.status === 0;
}

/**
 * Fire the "new message" hint. Fixed neutral text per D12 - the actual
 * expression lives in the dedicated heartbeat session, never in the toast.
 */
export function sendNewMessageHint(paths: WorkspacePaths): boolean {
  const r = runNotify(paths, ['-Title', 'Heartbeat', '-Message', '有新消息']);
  return r.status === 0 && /TOAST_SENT/.test(r.out);
}
