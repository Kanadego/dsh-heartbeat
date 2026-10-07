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

import fs from 'node:fs';

const STALE_MS = 15_000;
const WAIT_MS = 3_000;
const POLL_MS = 25;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
      if (Date.now() - fs.statSync(lock).mtimeMs > STALE_MS) {
        fs.rmSync(lock, { force: true });
        return tryAcquire(lock);
      }
    } catch {
      return tryAcquire(lock); // vanished between open and stat
    }
    return false;
  }
}

/**
 * Run `fn` while holding the lock for `target`. Acquisition waits up to
 * WAIT_MS, then gives up and runs anyway: a heartbeat must not be stopped by a
 * stale lock, and the caller's own read-modify-write is still the last writer
 * in the common (uncontended) case.
 */
export function withFileLock<T>(target: string, fn: () => T): T {
  const lock = `${target}.lock`;
  const deadline = Date.now() + WAIT_MS;
  let held = false;
  for (;;) {
    if (tryAcquire(lock)) {
      held = true;
      break;
    }
    if (Date.now() >= deadline) break;
    sleepSync(POLL_MS);
  }
  try {
    return fn();
  } finally {
    if (held) {
      try {
        fs.rmSync(lock, { force: true });
      } catch { /* already gone */ }
    }
  }
}
