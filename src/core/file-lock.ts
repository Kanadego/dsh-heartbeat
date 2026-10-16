// Cross-process advisory file lock (H-20, minimal tier).
//
// The seed pool and the observation inbox are WHOLE-FILE rewrites of DPAPI
// ciphertext — the vault cannot append to them — and the CLI runs as a second
// process against the same files. Two interleaved load→mutate→save cycles
// therefore let one side silently overwrite the other's write. The full fix
// (append-only journal + compaction) is v2.0 work; this keeps the writers
// honest in the meantime.
//
// The lock itself is a sibling file created with O_EXCL. A lock older than
// STALE_MS is treated as abandoned (its holder died mid-write) and reclaimed.
//
// HB-03 (2026-10-17 review) fixed the two ways the minimal tier was lying:
//   1. Waiting out WAIT_MS and then running `fn` ANYWAY made the lock advisory
//      in name only — the very interleaved rewrite it exists to prevent could
//      still happen, with the loser's data silently lost. Acquisition failure
//      is now fail-closed: `fn` never runs without the lock. Callers that must
//      keep going use `tryWithFileLock` and handle the `null`.
//   2. Staleness was mtime alone, so a LIVE holder whose write ran longer than
//      STALE_MS had its lock deleted underneath it (both writers then hold it).
//      A lock is now reclaimed only when the pid it names is no longer running.

import fs from 'node:fs';

const STALE_MS = 15_000;
const WAIT_MS = 3_000;
const POLL_MS = 25;
/** A lock whose owner cannot be identified is only reclaimed after this long. */
const UNKNOWN_HOLDER_MS = 2 * STALE_MS;

/** Thrown when the lock could not be taken: the guarded write did NOT happen. */
export class FileLockTimeoutError extends Error {
  readonly target: string;
  readonly waitedMs: number;
  constructor(target: string, waitedMs: number) {
    super(`file lock timeout after ${waitedMs}ms: ${target}`);
    this.name = 'FileLockTimeoutError';
    this.target = target;
    this.waitedMs = waitedMs;
  }
}

export interface FileLockOpts {
  /** How long to wait for the lock; defaults to WAIT_MS (3s). */
  waitMs?: number;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Is the process named in the lock file still running? Every doubt ("cannot
 *  read it", "no pid in it") counts as alive until UNKNOWN_HOLDER_MS has passed:
 *  deleting a live holder's lock is the failure this replaced. */
function holderAlive(lock: string, ageMs: number): boolean {
  let raw = '';
  try {
    raw = fs.readFileSync(lock, 'utf8');
  } catch {
    return ageMs < UNKNOWN_HOLDER_MS; // vanished or unreadable mid-write
  }
  const pid = Number.parseInt(raw.trim().split(/\s+/)[0] ?? '', 10);
  if (!Number.isInteger(pid) || pid <= 0) return ageMs < UNKNOWN_HOLDER_MS;
  if (pid === process.pid) return true; // our own re-entrant look; never steal
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // alive, not ours
  }
}

function tryAcquire(lock: string): boolean {
  try {
    const fd = fs.openSync(lock, 'wx');
    fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    // Reclaim a lock whose holder is gone.
    try {
      const ageMs = Date.now() - fs.statSync(lock).mtimeMs;
      if (ageMs > STALE_MS && !holderAlive(lock, ageMs)) {
        fs.rmSync(lock, { force: true });
        return tryAcquire(lock);
      }
    } catch {
      return tryAcquire(lock); // vanished between open and stat
    }
    return false;
  }
}

/** Take the lock, or give up after `waitMs`. Never blocks past the deadline. */
function acquire(lock: string, waitMs: number): boolean {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (tryAcquire(lock)) return true;
    if (Date.now() >= deadline) return false;
    sleepSync(POLL_MS);
  }
}

function release(lock: string): void {
  try {
    fs.rmSync(lock, { force: true });
  } catch { /* already gone */ }
}

/**
 * Run `fn` while holding the lock for `target`. Fail-closed (HB-03): if the
 * lock cannot be taken within `waitMs`, this throws FileLockTimeoutError and
 * `fn` is never called — a write without the lock is exactly the corruption the
 * lock exists to prevent. Use `tryWithFileLock` when "skip this write" is a
 * valid answer for the caller.
 */
export function withFileLock<T>(target: string, fn: () => T, opts: FileLockOpts = {}): T {
  const waitMs = opts.waitMs ?? WAIT_MS;
  const lock = `${target}.lock`;
  if (!acquire(lock, waitMs)) throw new FileLockTimeoutError(target, waitMs);
  try {
    return fn();
  } finally {
    release(lock);
  }
}

/**
 * `withFileLock`, but a lock that cannot be taken yields `null` instead of
 * throwing, and `fn` still never runs without the lock. Callers use this when
 * dropping the write (and saying so in the audit log) beats failing the beat.
 */
export function tryWithFileLock<T>(target: string, fn: () => T, opts: FileLockOpts = {}): T | null {
  const waitMs = opts.waitMs ?? WAIT_MS;
  const lock = `${target}.lock`;
  if (!acquire(lock, waitMs)) return null;
  try {
    return fn();
  } finally {
    release(lock);
  }
}
