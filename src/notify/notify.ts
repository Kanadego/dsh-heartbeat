// Windows toast channel (D12): attention hint ONLY - never carries the
// expression body. Wraps assets/notify.ps1 (self-registering AUMID).

import path from 'node:path';
import { runPowerShellFile } from '../core/ps.js';
import type { WorkspacePaths } from '../core/paths.js';

async function runNotify(paths: WorkspacePaths, args: string[]): Promise<{ status: number; out: string }> {
  const r = await runPowerShellFile(path.join(paths.assetsDir, 'notify.ps1'), args, 20_000);
  return { status: r.status, out: `${r.stdout}${r.stderr}`.trim() };
}

/** Register the toast identity if missing (idempotent, per machine/user). */
export async function ensureRegistered(paths: WorkspacePaths): Promise<boolean> {
  const check = await runNotify(paths, ['-Check']);
  if (/REGISTERED: yes/.test(check.out)) return true;
  const reg = await runNotify(paths, ['-RegisterOnly']);
  return reg.status === 0;
}

/**
 * Fire the "new message" hint. Fixed neutral text per D12 - the actual
 * expression lives in the dedicated heartbeat session, never in the toast.
 */
export async function sendNewMessageHint(paths: WorkspacePaths): Promise<boolean> {
  const r = await runNotify(paths, ['-Title', 'Heartbeat', '-Message', '有新消息']);
  return r.status === 0 && /TOAST_SENT/.test(r.out);
}

/** Weekly report ready hint (v1.8.0): same D12 discipline — announces that a
 * report exists, never carries its content. */
export async function sendWeeklyReadyHint(paths: WorkspacePaths): Promise<boolean> {
  const r = await runNotify(paths, ['-Title', '心跳周报', '-Message', '本期周报已生成']);
  return r.status === 0 && /TOAST_SENT/.test(r.out);
}
