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
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function atomicWriteJsonSync(target: string, value: unknown): void {
  atomicWriteFileSync(target, JSON.stringify(value, null, 2));
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
