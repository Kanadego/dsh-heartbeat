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
  timingSafeEqual,
} from 'node:crypto';
import type { PathGuard } from '../core/path-guard.js';
import type { WorkspacePaths } from '../core/paths.js';
import { isEncrypted, loadEncryptedText, saveEncryptedText } from './vault.js';

export const MIGRATE_MAGIC = 'HBMIG1';
export const MIGRATE_VERSION = 1;
const KDF_N = 163_84; // scrypt cost (Node default)
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
];

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

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, { N: KDF_N, r: 8, p: 1 });
}

/** Build the container file content. Everything sensitive lives inside the
 * ciphertext; the outer JSON carries only crypto parameters. */
export function encryptContainer(entries: MigrateEntry[], passphrase: string, now = new Date()): string {
  if (!passphrase) throw new Error('migrate: passphrase must not be empty');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
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
  let outer: { magic?: string; kdf?: { salt?: string }; iv?: string; tag?: string; data?: string };
  try {
    outer = JSON.parse(text);
  } catch {
    throw new Error('migrate: not a migration container (bad JSON)');
  }
  if (outer.magic !== MIGRATE_MAGIC) throw new Error('migrate: not a migration container (bad magic)');
  const salt = Buffer.from(String(outer.kdf?.salt ?? ''), 'hex');
  const iv = Buffer.from(String(outer.iv ?? ''), 'hex');
  const tag = Buffer.from(String(outer.tag ?? ''), 'hex');
  const data = Buffer.from(String(outer.data ?? ''), 'base64');
  const key = deriveKey(passphrase, salt);
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
  // Constant-time-ish sanity on the passphrase result is implicit in GCM auth;
  // timingSafeEqual is used for the version check to keep the import path
  // uniform without importing more crypto surface.
  const v = Buffer.from([inner.version]);
  timingSafeEqual(v, Buffer.from([MIGRATE_VERSION]));
  return { createdAt: inner.createdAt, files: inner.files };
}

export interface MigrateImportResult {
  restored: string[];
  backedUp: string[];
  skipped: string[];
}

/** Restore entries into the local dataDir, re-encrypting DPAPI files with the
 * LOCAL machine key. Existing files are copied aside first. */
export function applyMigrationEntries(guard: PathGuard, paths: WorkspacePaths, files: MigrateEntry[], now = Date.now()): MigrateImportResult {
  const restored: string[] = [];
  const backedUp: string[] = [];
  const skipped: string[] = [];
  const stamp = new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  for (const f of files) {
    const rel = String(f.path ?? '');
    const abs = path.join(paths.dataDir, rel);
    let absCanon: string;
    try {
      absCanon = guard.assert(abs);
    } catch {
      skipped.push(rel); // path refused by the guard — never write it
      continue;
    }
    if (rel.includes('..') || path.isAbsolute(rel)) {
      skipped.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(absCanon), { recursive: true });
    if (fs.existsSync(absCanon)) {
      fs.copyFileSync(absCanon, `${absCanon}.bak-migrate-${stamp}`);
      backedUp.push(rel);
    }
    if (f.encrypted) saveEncryptedText(guard, absCanon, f.content);
    else fs.writeFileSync(absCanon, f.content, 'utf8');
    restored.push(rel);
  }
  return { restored, backedUp, skipped };
}
