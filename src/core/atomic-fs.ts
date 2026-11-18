// Crash-safe file replacement: write to a random-suffix temp file in the SAME
// directory as the target, then rename over it. Same-directory rename stays
// on one volume (atomic) and Node's rename replaces existing files on Windows.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomFillSync } from 'node:crypto';

export function tmpSibling(target: string, tag = 'w'): string {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${tag}-${randomUUID().slice(0, 8)}.tmp`,
  );
}

export function atomicWriteFileSync(target: string, data: string | Uint8Array): void {
  const tmp = tmpSibling(target);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, data);
    // 低优先级 review (2026-10-17): rename is atomic against a crash of THIS
    // process, but without a flush the renamed file can still point at blocks
    // the OS never wrote — a power loss then leaves an empty or partial file
    // where a complete one is promised. Flush before publishing.
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, target);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* the write path already failed */ }
    }
    fs.rmSync(tmp, { force: true });
  }
}

export function atomicWriteJsonSync(target: string, value: unknown): void {
  atomicWriteFileSync(target, JSON.stringify(value, null, 2));
}

/** Exclusive-create fallback when hard links are unavailable (exFAT/FAT32
 *  sticks, SMB/NAS mounts, link-restricted directories: EPERM / ENOTSUP /
 *  EACCES). openSync('wx') is itself an O_EXCL exclusive create, so
 *  concurrent-creator safety survives; what is lost is the crash-atomic
 *  publication (a power loss mid-write can leave a partial file) — the same
 *  exposure the pre-link writeFileSync(flag 'wx') seeding always had. A write
 *  that fails (ENOSPC / EIO) removes the stub it created before rethrowing:
 *  a half-written target would make every later exclusive create hit EEXIST
 *  forever (N16② review 低3). A failed openSync never removes anything — the
 *  file was never ours, and EEXIST is the first-creator-wins contract. */
function exclusiveWriteDirectSync(target: string, data: string | Uint8Array): void {
  const fd = fs.openSync(target, 'wx');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* close must not mask the write error */ }
    try { fs.rmSync(target, { force: true }); } catch { /* best effort */ }
    throw e;
  }
  fs.closeSync(fd);
}

/** Create-if-absent with atomic publication. rename() would silently REPLACE
 *  a file a concurrent writer created between our write and the rename, so
 *  exclusive publication goes through a hard link instead: link fails with
 *  EEXIST when the target came into existence meanwhile, which is exactly the
 *  O_EXCL contract (AGENTS.md #1: every data write is atomic — "create a
 *  fresh file" is no exception, a crash mid-write must not leave a partial
 *  file that looks seeded). */
export function atomicCreateFileSync(target: string, data: string | Uint8Array): void {
  const tmp = tmpSibling(target, 'x');
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    try {
      fs.linkSync(tmp, target);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return; // first creator wins
      if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EACCES') {
        exclusiveWriteDirectSync(target, data);
        return;
      }
      throw e;
    }
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* the write path already failed */ }
    }
    fs.rmSync(tmp, { force: true });
  }
}

/** Overwrite a file's bytes with random data before unlinking. */
export function shredFileSync(target: string, passes = 3): void {
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error(`shred: not a file: ${target}`);
  const buf = Buffer.alloc(Math.max(stat.size, 1));
  for (let i = 0; i < passes; i++) {
    randomFillSync(buf);
    fs.writeFileSync(target, buf);
  }
  fs.rmSync(target, { force: true });
}

/**
 * Best-effort burn for a plaintext window: shred it when it exists, ignore it
 * when it is already gone (H-59 — `rm` alone leaves the bytes on disk).
 */
export function burnFileSync(target: string): void {
  try {
    shredFileSync(target);
  } catch {
    fs.rmSync(target, { force: true });
  }
}
