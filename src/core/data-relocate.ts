// One-time relocation of the data dir out of the package tree (issue #2).
//
// Installs created before v1.9.2 defaulted to `packageRoot()/data`, and every
// `dsh plugin add` / upgrade replaces the package directory wholesale — so a
// reinstall deleted the profile, the gate and the ledger, which the original
// design meant to keep until an explicit CLI `burn`. The default now lives at
// `$DSH_HOME/heartbeat-data`; this module moves an existing package-local tree
// there.
//
// Safety order — a failure at any point leaves the original untouched:
//   1. copy src -> backup (kept until the move is verified and committed)
//   2. copy src -> dst.staging-<stamp>
//   3. verify staging against src: same file list, same size + sha256, and
//      every plaintext .json/.jsonl still parses
//   4. rename staging -> dst (same volume, atomic)
//   5. only then delete src and the backup
// The caller keeps using `src` unless the result is `relocated`.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Directories the bootstrap always creates: their presence alone is no payload. */
const SKELETON_DIRS = ['settings', 'logs', 'tmp', 'exports'];
/** Scratch space (decrypt windows, downloads): never copied, never verified. */
const SCRATCH_DIR = 'tmp';
const MAGIC = Buffer.from('KHBV1', 'ascii');

export interface RelocateOptions {
  srcDir: string;
  dstDir: string;
  /** Injectable clock, so tests get deterministic backup/staging names. */
  now?: number;
}

export type RelocateResult =
  | {
      action: 'relocated';
      /** Package-local tree the data came from (now deleted). */
      srcDir: string;
      dstDir: string;
      backupDir: string;
      files: number;
      bytes: number;
      /** Plaintext JSON/JSONL that does not parse (verified byte-identical). */
      warnings: string[];
      /** Paths that could not be deleted after the move (cosmetic leftovers). */
      leftovers: string[];
    }
  | { action: 'skipped'; reason: 'source-missing' | 'no-payload' | 'destination-exists' }
  | {
      action: 'failed';
      stage: 'backup' | 'copy' | 'verify' | 'commit';
      problems: string[];
      /** Null when the backup itself could not be created. */
      backupDir: string | null;
    };

export interface VerifyResult {
  /** Byte-for-byte the same file list, sizes and contents. */
  ok: boolean;
  files: number;
  bytes: number;
  problems: string[];
  /**
   * Plaintext JSON/JSONL files that do not parse. They are reported but do not
   * fail the move: an identical copy of a file that was already damaged is
   * still byte-for-byte the user's data, and refusing to relocate would strand
   * the data dir in the package forever.
   */
  warnings: string[];
}

/**
 * True when a data dir holds real user data. An empty bootstrap skeleton
 * (`settings/ logs/ tmp/ exports/`, all empty) does not count — otherwise a
 * freshly created default dir would shadow a legacy tree with actual data.
 */
export function hasPayload(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) return true;
    if (!SKELETON_DIRS.includes(entry.name)) return true;
    if (entry.name === SCRATCH_DIR) continue;
    if (fs.readdirSync(path.join(dir, entry.name)).length > 0) return true;
  }
  return false;
}

/** Every file under `dir` (relative, `/`-separated, sorted), excluding tmp/. */
function walk(dir: string, prefix = '', out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!prefix && entry.name === SCRATCH_DIR) continue;
      walk(path.join(dir, entry.name), rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out.sort();
}

function copyTree(src: string, dst: string): void {
  const scratch = path.resolve(path.join(src, SCRATCH_DIR));
  fs.cpSync(src, dst, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    filter: (from) => path.resolve(from) !== scratch,
  });
}

function removeTree(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** KHBV1 header check (local copy: importing vault here would cycle through paths). */
function isEncryptedFile(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(MAGIC.length);
    const read = fs.readSync(fd, head, 0, MAGIC.length, 0);
    return read === MAGIC.length && head.equals(MAGIC);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Schema-free readability check: an encrypted container is opaque here (its
 * bytes were already compared by hash), a plaintext .json/.jsonl must still
 * parse — that is what catches a half-written or truncated copy.
 */
function parsesAsJson(file: string): boolean {
  if (isEncryptedFile(file)) return true;
  const text = fs.readFileSync(file, 'utf8');
  try {
    if (file.endsWith('.jsonl')) {
      for (const line of text.split('\n')) if (line.trim()) JSON.parse(line);
      return true;
    }
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compare a copy against its source: identical file list, identical size and
 * content (the hard gate), plus a readability report on the plaintext
 * JSON/JSONL in the copy (warnings only — see VerifyResult).
 */
export function verifyTrees(srcDir: string, dstDir: string): VerifyResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  let files = 0;
  let bytes = 0;
  if (!fs.existsSync(dstDir)) {
    return { ok: false, files: 0, bytes: 0, problems: [`copy missing: ${dstDir}`], warnings };
  }
  const expected = walk(srcDir);
  const actual = walk(dstDir);
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  for (const rel of expected) if (!actualSet.has(rel)) problems.push(`missing: ${rel}`);
  for (const rel of actual) if (!expectedSet.has(rel)) problems.push(`unexpected: ${rel}`);
  for (const rel of expected) {
    const from = path.join(srcDir, rel);
    const to = path.join(dstDir, rel);
    if (!fs.existsSync(to)) continue; // already reported above
    const sizeFrom = fs.statSync(from).size;
    const sizeTo = fs.statSync(to).size;
    files += 1;
    bytes += sizeFrom;
    if (sizeFrom !== sizeTo) {
      problems.push(`size differs: ${rel} (${sizeFrom} -> ${sizeTo})`);
      continue;
    }
    if (sha256(from) !== sha256(to)) {
      problems.push(`content differs: ${rel}`);
      continue;
    }
    if (/\.(json|jsonl)$/i.test(rel) && !parsesAsJson(to)) warnings.push(`unparseable: ${rel}`);
  }
  return { ok: problems.length === 0, files, bytes, problems, warnings };
}

function stamp(now: number): string {
  const d = new Date(now);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Move a package-local data dir to its new home. Never throws: every failure
 * is reported as `failed` with the original tree left in place.
 */
export function relocateDataDir(opts: RelocateOptions): RelocateResult {
  const srcDir = path.resolve(opts.srcDir);
  const dstDir = path.resolve(opts.dstDir);
  if (!fs.existsSync(srcDir)) return { action: 'skipped', reason: 'source-missing' };
  if (!hasPayload(srcDir)) return { action: 'skipped', reason: 'no-payload' };
  if (hasPayload(dstDir)) return { action: 'skipped', reason: 'destination-exists' };

  const suffix = stamp(opts.now ?? Date.now());
  const backupDir = `${srcDir}.bak-relocate-${suffix}`;
  const stagingDir = `${dstDir}.staging-${suffix}`;

  // 1. backup first — the user asked for a copy that outlives a failed move.
  try {
    copyTree(srcDir, backupDir);
  } catch (error) {
    return { action: 'failed', stage: 'backup', problems: [errorText(error)], backupDir: null };
  }

  // 2. copy to a staging dir beside the destination (same volume → atomic rename).
  try {
    copyTree(srcDir, stagingDir);
  } catch (error) {
    return { action: 'failed', stage: 'copy', problems: [errorText(error)], backupDir };
  }

  // 3. verify before anything is deleted or published.
  const verified = verifyTrees(srcDir, stagingDir);
  if (!verified.ok) {
    try {
      removeTree(stagingDir);
    } catch {
      // A stranded staging dir is harmless: the next run overwrites it.
    }
    return { action: 'failed', stage: 'verify', problems: verified.problems, backupDir };
  }

  // 4. publish: the destination may hold an empty skeleton from an earlier
  //    bootstrap, which is not payload (checked above), so clear it and rename.
  try {
    if (fs.existsSync(dstDir)) removeTree(dstDir);
    fs.renameSync(stagingDir, dstDir);
  } catch (error) {
    try {
      removeTree(stagingDir);
    } catch {
      // best effort
    }
    return { action: 'failed', stage: 'commit', problems: [errorText(error)], backupDir };
  }

  // 5. the new tree is live; the originals go last. A leftover only wastes
  //    space — the destination already wins on the next resolve.
  const leftovers: string[] = [];
  try {
    removeTree(srcDir);
  } catch {
    leftovers.push(srcDir);
  }
  try {
    removeTree(backupDir);
  } catch {
    leftovers.push(backupDir);
  }

  return {
    action: 'relocated',
    srcDir,
    dstDir,
    backupDir,
    files: verified.files,
    bytes: verified.bytes,
    warnings: verified.warnings,
    leftovers,
  };
}
