import { spawn } from 'node:child_process';

/**
 * How to launch a platform's default handler for a file.
 */
export interface Opener {
  cmd: string;
  args: (file: string) => string[];
}

/**
 * Which opener a given platform uses. Split out from the spawn so the platform
 * table is testable without actually launching anything.
 */
export function openerFor(platform: NodeJS.Platform): Opener {
  if (platform === 'win32') return { cmd: 'cmd', args: (f) => ['/c', 'start', '', f] };
  if (platform === 'darwin') return { cmd: 'open', args: (f) => [f] };
  return { cmd: 'xdg-open', args: (f) => [f] };
}

/**
 * Open a file with the platform's default handler.
 *
 * `opener` is injectable so tests can force the "binary does not exist" path on
 * any OS; production always passes the platform default.
 *
 * Why this exists: the callers used to inline `spawn('cmd', ['/c', 'start', '',
 * f])`, which is Windows-only. Off Windows that spawn fails with ENOENT, and
 * Node reports a spawn failure through the child's *asynchronous* `error`
 * event rather than as a synchronous throw — so a caller wrapped in try/catch
 * still lets the exception escape as an uncaughtException. That is exactly how
 * `ledger.open` / `excerpt.open` used to kill the whole host process.
 *
 * Two deliberate choices below:
 *  - the child is spawned detached with stdio swallowed, and
 *  - a spawn failure is swallowed on purpose, because a machine with no file
 *    manager is not a reason to fail the action. Callers already return the
 *    path, so the caller-side contract is unchanged.
 */
function spawnDetached(cmd: string, args: string[]): void {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => { /* no opener on this machine; nothing to recover */ });
    child.unref();
  } catch {
    /* synchronous spawn failure — same contract as the async one above */
  }
}

export function openPath(file: string, opener: Opener = openerFor(process.platform)): void {
  spawnDetached(opener.cmd, opener.args(file));
}
