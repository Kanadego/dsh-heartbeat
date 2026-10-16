// Cross-machine migration (v1.8.0). DPAPI binds the sensitive stores to one
// machine + account, so a new machine cannot read them — this module packs
// the memory files into ONE passphrase-encrypted container (AES-256-GCM,
// scrypt-derived key, node:crypto only) that can travel safely, and restores
// them on the other side re-encrypted with the LOCAL DPAPI.
//
// Restore is byte-identical: for each file we record whether it was DPAPI
// encrypted on disk (isEncrypted magic check) and write it back through the
// same path — no per-module write semantics to keep in sync. Existing files
// are backed up before overwrite (rule 4).

import fs from 'node:fs';
import path from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import type { PathGuard } from '../core/path-guard.js';
import type { WorkspacePaths } from '../core/paths.js';
import { isEncrypted, loadEncryptedText, saveEncryptedText } from './vault.js';

export const MIGRATE_MAGIC = 'HBMIG1';
export const MIGRATE_VERSION = 1;
/** scrypt cost for NEW containers (2^14 = Node's default, 16 MiB of work).
 *  Reading is parameterised by the container's own kdf.N, so raising this
 *  never orphans an existing export. */
const KDF_N = 163_84;
/** Hard bounds for a container-supplied N: a hostile/broken container must not
 *  be able to make the import allocate unbounded memory. */
const KDF_N_MIN = 1 << 12; // 2^12 = 4 MiB
const KDF_N_MAX = 1 << 16; // 2^16 = 64 MiB
/** Node's scrypt maxmem defaults to 32 MiB, which N=2^15 already exceeds — a
 *  legal container with a larger N would fail without an explicit cap. */
const SCRYPT_MAXMEM = 128 * 1024 * 1024;
const KEY_LEN = 32;

/** Memory-relevant runtime files (dataDir-relative). Deliberately NOT here:
 * gate.json (machine-local counters + home session id — the new machine
 * builds its own) and screen snapshots (per-beat transients, not memory). */
export const MIGRATE_FILES = [
  'profile.json',
  'profile_snapshot.json',
  'profile_inbox.jsonl',
  'profile_journal.jsonl',
  'profile_rhythm.json',
  'sent.json',
  'browse.json',
  'seeds.jsonl',
  'ledger.md',
  'cursors.json',
  // v1.9.0: persona report log + topic preference stats
  'seed_report.jsonl',
  'preference.json',
];

/** HB-18: an import writes with the user's privileges inside data/, so the set
 *  of names a container may touch is closed, not merely sanitised. Anything an
 *  export can produce is here; everything else (gate.json, settings/, vault.key,
 *  other modules' files) is refused. */
const MIGRATE_ARCHIVE_RE = /^profile_journal\.archive-\d+\.jsonl$/;
const MIGRATE_WEEKLY_RE = /^weekly\/[^/\\]+\.json$/;

export function isMigratablePath(rel: string): boolean {
  if (MIGRATE_FILES.includes(rel)) return true;
  if (MIGRATE_ARCHIVE_RE.test(rel)) return true;
  if (MIGRATE_WEEKLY_RE.test(rel)) return true;
  return false;
}

/** HB-18: budget for a container-supplied payload. Generous next to a real
 *  memory (a few MB), small next to what a hostile container would like. */
export const MIGRATE_MAX_FILES = 5_000;
export const MIGRATE_MAX_BYTES = 64 * 1024 * 1024;

export interface MigrateEntry {
  path: string; // dataDir-relative
  encrypted: boolean; // was DPAPI-encrypted on the source machine
  content: string;
}

export interface MigrateProgress {
  packed: string[];
  missing: string[];
}

function collectWeeklyFiles(guard: PathGuard, paths: WorkspacePaths): string[] {
  const dir = path.join(paths.dataDir, 'weekly');
  try {
    return fs.readdirSync(guard.assert(dir))
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join('weekly', f).replace(/\\/g, '/'));
  } catch {
    return [];
  }
}

/** Journal archive shards (snapshot rotation output) travel with the memory. */
function collectJournalArchives(guard: PathGuard, paths: WorkspacePaths): string[] {
  try {
    return fs.readdirSync(guard.assert(paths.dataDir))
      .filter((f) => f.startsWith('profile_journal.archive-') && f.endsWith('.jsonl'));
  } catch {
    return [];
  }
}

/** Read every migration file. A DPAPI file that fails to decrypt aborts the
 * export — a silent half-memory container would be worse than a loud error. */
export function collectMigrationEntries(guard: PathGuard, paths: WorkspacePaths): { entries: MigrateEntry[]; progress: MigrateProgress } {
  const entries: MigrateEntry[] = [];
  const packed: string[] = [];
  const missing: string[] = [];
  const rels = [...MIGRATE_FILES, ...collectJournalArchives(guard, paths), ...collectWeeklyFiles(guard, paths)];
  for (const rel of rels) {
    const abs = path.join(paths.dataDir, rel);
    let absCanon: string;
    try {
      absCanon = guard.assert(abs);
    } catch {
      missing.push(rel);
      continue;
    }
    if (!fs.existsSync(absCanon)) {
      missing.push(rel);
      continue;
    }
    const encrypted = isEncrypted(absCanon);
    const content = encrypted
      ? loadEncryptedText(guard, absCanon) ?? (() => { throw new Error(`cannot decrypt ${rel} on this machine`); })()
      : fs.readFileSync(absCanon, 'utf8');
    entries.push({ path: rel.replace(/\\/g, '/'), encrypted, content });
    packed.push(rel);
  }
  return { entries, progress: { packed, missing } };
}

/** Derive the key with the container's OWN cost parameter. `n` must already
 *  have passed assertKdfN (export uses the current default). */
function deriveKey(passphrase: string, salt: Buffer, n: number): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, { N: n, r: 8, p: 1, maxmem: SCRYPT_MAXMEM });
}

/** Validate the scrypt cost carried by a container. A missing/absurd N is a
 *  BROKEN container — reported as such, never as "wrong passphrase" (before
 *  2026-10-06 the N in the container was ignored and the two were the same
 *  error, so raising the cost would have orphaned every old export). */
function assertKdfN(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || (n & (n - 1)) !== 0) {
    throw new Error('migrate: container has invalid kdf parameters (N must be a power of two)');
  }
  if (n < KDF_N_MIN || n > KDF_N_MAX) {
    throw new Error(`migrate: container kdf N ${n} is outside the supported range [${KDF_N_MIN}, ${KDF_N_MAX}]`);
  }
  return n;
}

/** HB-18: a container does not get to decide how much work the import does. */
function assertMigrateBudget(files: unknown[]): asserts files is MigrateEntry[] {
  if (files.length > MIGRATE_MAX_FILES) {
    throw new Error(`migrate: container lists ${files.length} files, over the ${MIGRATE_MAX_FILES} limit`);
  }
  let bytes = 0;
  for (const f of files) {
    const entry = f as { path?: unknown; content?: unknown } | null;
    if (!entry || typeof entry.path !== 'string' || typeof entry.content !== 'string') {
      throw new Error('migrate: container file entry is malformed');
    }
    bytes += Buffer.byteLength(entry.content, 'utf8');
    if (bytes > MIGRATE_MAX_BYTES) {
      throw new Error(`migrate: container payload exceeds ${MIGRATE_MAX_BYTES} bytes`);
    }
  }
}

/** Build the container file content. Everything sensitive lives inside the
 * ciphertext; the outer JSON carries only crypto parameters. */
export function encryptContainer(entries: MigrateEntry[], passphrase: string, now = new Date()): string {
  if (!passphrase) throw new Error('migrate: passphrase must not be empty');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt, KDF_N);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify({ version: MIGRATE_VERSION, createdAt: now.toISOString(), files: entries }), 'utf8');
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    magic: MIGRATE_MAGIC,
    kdf: { name: 'scrypt', salt: salt.toString('hex'), N: KDF_N },
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: data.toString('base64'),
  }, null, 1) + '\n';
}

/** Parse + decrypt a container. Throws (loudly) on a wrong passphrase or a
 * corrupted file — never returns partial data. */
export function decryptContainer(text: string, passphrase: string): { createdAt: string; files: MigrateEntry[] } {
  let outer: { magic?: string; kdf?: { salt?: string; N?: unknown }; iv?: string; tag?: string; data?: string };
  try {
    outer = JSON.parse(text);
  } catch {
    throw new Error('migrate: not a migration container (bad JSON)');
  }
  if (outer.magic !== MIGRATE_MAGIC) throw new Error('migrate: not a migration container (bad magic)');
  const n = assertKdfN(outer.kdf?.N);
  const salt = Buffer.from(String(outer.kdf?.salt ?? ''), 'hex');
  const iv = Buffer.from(String(outer.iv ?? ''), 'hex');
  const tag = Buffer.from(String(outer.tag ?? ''), 'hex');
  // HB-18: refuse an oversized payload before decoding it. base64 runs ~4/3 of
  // the ciphertext, so this cheap length check bounds the allocation below.
  const dataB64 = String(outer.data ?? '');
  if (dataB64.length > MIGRATE_MAX_BYTES * 2) {
    throw new Error(`migrate: container payload is too large (${dataB64.length} base64 chars)`);
  }
  const data = Buffer.from(dataB64, 'base64');
  const key = deriveKey(passphrase, salt, n);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    throw new Error('migrate: wrong passphrase or corrupted container');
  }
  const inner = JSON.parse(plain.toString('utf8')) as { version: number; createdAt: string; files: MigrateEntry[] };
  if (inner.version !== MIGRATE_VERSION) throw new Error(`migrate: unsupported container version ${inner.version}`);
  if (!Array.isArray(inner.files)) throw new Error('migrate: container has no file list');
  assertMigrateBudget(inner.files);
  return { createdAt: inner.createdAt, files: inner.files };
}

export interface MigrateImportResult {
  restored: string[];
  backedUp: string[];
  skipped: string[];
  /** H-21: files put back from their backups after a failed commit phase. */
  rolledBack?: string[];
  /** H-21: set when the commit phase failed and the import was rolled back. */
  error?: string;
}

/**
 * Restore entries into the local dataDir, re-encrypting DPAPI files with the
 * LOCAL machine key.
 *
 * H-21: this used to be a per-file "back up, then overwrite" loop with no
 * pre-flight and no rollback — a failure halfway through left a mixed memory
 * (a new `profile.json` next to a stale `profile_journal.jsonl`). Now it runs
 * in two phases: stage every entry next to its target (nothing visible changes
 * yet), then commit each one by rename. A commit failure rolls the
 * already-committed files back from their backups.
 *
 * HB-06 (2026-10-17): the phases are all-or-nothing at BOTH ends. Earlier a
 * staging failure only skipped that entry and the rest were still committed,
 * so one bad path was enough to leave a half-migrated memory. Now any skipped
 * entry aborts the whole import with nothing written; the reason is returned
 * in `error` alongside the offending names.
 */
export function applyMigrationEntries(guard: PathGuard, paths: WorkspacePaths, files: MigrateEntry[], now = Date.now()): MigrateImportResult {
  const restored: string[] = [];
  const backedUp: string[] = [];
  const skipped: string[] = [];
  const stamp = new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const staged: Array<{ rel: string; abs: string; incoming: string }> = [];
  for (const f of files) {
    const rel = String(f.path ?? '');
    // String-level rejection BEFORE the path is resolved: the guard's realpath
    // check already refuses escapes, but an import must not depend on another
    // module staying correct. HB-18: and the name must be one an export can
    // produce - a container may not reach settings/, gate.json or vault.key.
    if (!rel || rel.includes('..') || path.isAbsolute(rel) || !isMigratablePath(rel)) {
      skipped.push(rel);
      continue;
    }
    const abs = path.join(paths.dataDir, rel);
    let absCanon: string;
    try {
      absCanon = guard.assert(abs);
    } catch {
      skipped.push(rel); // path refused by the guard — never write it
      continue;
    }
    const incoming = `${absCanon}.incoming-${stamp}`;
    try {
      fs.mkdirSync(path.dirname(absCanon), { recursive: true });
      if (f.encrypted) saveEncryptedText(guard, incoming, f.content);
      else fs.writeFileSync(incoming, f.content, 'utf8');
      staged.push({ rel, abs: absCanon, incoming });
    } catch {
      skipped.push(rel);
      try {
        fs.rmSync(incoming, { force: true });
      } catch {
        /* nothing staged */
      }
    }
  }
  // HB-06: staging is the point of no return. A single entry that could not be
  // staged used to be skipped while the rest were committed, which left a
  // half-migrated memory (a new profile.json next to a stale journal). Any skip
  // now aborts the import with nothing written; the reason travels in `error`.
  if (skipped.length > 0) {
    for (const s of staged) {
      try {
        fs.rmSync(s.incoming, { force: true });
      } catch {
        /* nothing staged */
      }
    }
    return {
      restored: [],
      backedUp: [],
      skipped,
      error: `staging failed for ${skipped.length} file(s): ${skipped.join(', ')}; nothing was imported`,
    };
  }
  const committed: Array<{ rel: string; abs: string; backup: string | null }> = [];
  try {
    for (const s of staged) {
      let backup: string | null = null;
      if (fs.existsSync(s.abs)) {
        backup = `${s.abs}.bak-migrate-${stamp}`;
        fs.copyFileSync(s.abs, backup);
        backedUp.push(s.rel);
      }
      fs.renameSync(s.incoming, s.abs);
      committed.push({ rel: s.rel, abs: s.abs, backup });
      restored.push(s.rel);
    }
    return { restored, backedUp, skipped };
  } catch (e) {
    // Roll back so the dataDir never holds a half-migrated mix; staged files
    // that were never committed are simply dropped.
    const rolledBack: string[] = [];
    for (const c of committed.reverse()) {
      try {
        if (c.backup) fs.renameSync(c.backup, c.abs);
        else fs.rmSync(c.abs, { force: true });
        rolledBack.push(c.rel);
      } catch {
        /* best effort — the backup file itself is still on disk */
      }
    }
    for (const s of staged) {
      if (committed.some((c) => c.abs === s.abs)) continue;
      try {
        fs.rmSync(s.incoming, { force: true });
      } catch {
        /* already gone */
      }
    }
    return { restored: [], backedUp, skipped, rolledBack, error: String(e) };
  }
}
