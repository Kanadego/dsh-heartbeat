// Transparent encryption read/write layer.
//
// Two container generations live side by side on disk:
//   KHBV1  legacy — DPAPI (CurrentUser) over the whole payload, produced by
//          assets/vault.ps1. Every read/write costs one PowerShell process,
//          which is why a beat that touches many files paid seconds of spawn
//          time (HB-11).
//   KHBV2  current — AES-256-GCM applied in-process, keyed by a 32-byte random
//          master key. The key itself is stored DPAPI-protected in
//          <dataDir>/vault.key, so the only thing that still needs DPAPI is
//          unwrapping that one file, and that happens once per process (cached).
//
// Migration contract (v2.0): an upgraded plugin must keep opening everything an
// older version wrote, and a downgraded one must not lose data either — so
// reads accept BOTH containers, while writes always produce KHBV2. Legacy files
// are rewritten in place by upgradeVaultTree(), which the CLI runs on demand.
// Encryption stays fail-closed: a missing or unreadable master key throws, and
// no path ever falls back to plaintext.
//
// Plaintext never touches the disk on the KHBV2 path: the payload goes straight
// from a Buffer through AES-GCM into the temp container that is renamed into
// place. (KHBV1 needed a plaintext window under data/tmp for PowerShell.)

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { PathGuard } from '../core/path-guard.js';
import { workspace } from '../core/paths.js';
import { burnFileSync } from '../core/atomic-fs.js';
import { withFileLock } from '../core/file-lock.js';
import { matchFilesRecursive } from '../core/fs-walk.js';

/** Legacy container: 5-byte magic + DPAPI blob. */
const MAGIC_V1 = Buffer.from('KHBV1', 'ascii');
/** Current container: magic + version + nonce + tag + ciphertext. */
const MAGIC_V2 = Buffer.from('KHBV2', 'ascii');
const V2_VERSION = 1;
const V2_NONCE_BYTES = 12;
const V2_TAG_BYTES = 16;
const V2_HEADER_BYTES = MAGIC_V2.length + 1 + V2_NONCE_BYTES + V2_TAG_BYTES;
/** Additional authenticated data: pins the header, so a container cannot be relabelled. */
const V2_AAD = Buffer.concat([MAGIC_V2, Buffer.from([V2_VERSION])]);
const KEY_BYTES = 32;
const KEY_FILE_NAME = 'vault.key';
const VAULT_TIMEOUT_MS = 30_000;

let cachedScriptPath: string | null = null;

function vaultScriptPath(): string {
  if (cachedScriptPath) return cachedScriptPath;
  const script = path.join(workspace().assetsDir, 'vault.ps1');
  if (!fs.existsSync(script)) throw new Error(`vault script missing: ${script}`);
  cachedScriptPath = script;
  return script;
}

function tmpPlainName(target: string): string {
  return path.join(workspace().tmpDir, `.${path.basename(target)}.${randomUUID().slice(0, 8)}.plain`);
}

function tmpEncName(target: string): string {
  return path.join(workspace().tmpDir, `.${path.basename(target)}.${randomUUID().slice(0, 8)}.enc`);
}

function runVault(guard: PathGuard, args: string[]): void {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', vaultScriptPath(), ...args],
    { timeout: VAULT_TIMEOUT_MS, encoding: 'utf8' },
  );
  if (r.error) throw new Error(`vault spawn failed: ${String(r.error)}`);
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join('; ');
    throw new Error(`vault ${args[0]} failed (exit ${r.status}): ${detail}`);
  }
}

export type ContainerKind = 'v2' | 'v1' | 'plain';

/** Which container a file carries, decided from its first bytes. */
export function containerKind(file: string): ContainerKind {
  if (!fs.existsSync(file)) return 'plain';
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(MAGIC_V2.length);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    if (read === MAGIC_V1.length && head.subarray(0, MAGIC_V1.length).equals(MAGIC_V1)) return 'v1';
    if (read === MAGIC_V2.length && head.equals(MAGIC_V2)) return 'v2';
    return 'plain';
  } finally {
    fs.closeSync(fd);
  }
}

/** True for either container generation (plaintext files stay plaintext). */
export function isEncrypted(file: string): boolean {
  return containerKind(file) !== 'plain';
}

function encryptBlob(key: Buffer, plain: Buffer): Buffer {
  const nonce = randomBytes(V2_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(V2_AAD);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC_V2, Buffer.from([V2_VERSION]), nonce, cipher.getAuthTag(), body]);
}

function decryptBlob(key: Buffer, raw: Buffer): Buffer {
  if (raw.length < V2_HEADER_BYTES) throw new Error('vault: truncated KHBV2 container');
  if (!raw.subarray(0, MAGIC_V2.length).equals(MAGIC_V2)) throw new Error('vault: missing KHBV2 header');
  const version = raw[MAGIC_V2.length]!;
  if (version !== V2_VERSION) throw new Error(`vault: unsupported KHBV2 version ${version}`);
  const nonceAt = MAGIC_V2.length + 1;
  const tagAt = nonceAt + V2_NONCE_BYTES;
  const bodyAt = tagAt + V2_TAG_BYTES;
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(nonceAt, tagAt));
  decipher.setAAD(Buffer.concat([MAGIC_V2, Buffer.from([version])]));
  decipher.setAuthTag(raw.subarray(tagAt, bodyAt));
  // final() throws when the tag does not verify (tampered or wrong key).
  return Buffer.concat([decipher.update(raw.subarray(bodyAt)), decipher.final()]);
}

function legacyUnprotect(guard: PathGuard, file: string, out: string): void {
  runVault(guard, ['unprotect', '-InFile', file, '-OutFile', out]);
}

function legacyProtect(guard: PathGuard, inFile: string, out: string): void {
  runVault(guard, ['protect', '-InFile', inFile, '-OutFile', out]);
}

/** Path of the DPAPI-wrapped master key that every KHBV2 container is keyed by. */
export function vaultKeyPath(): string {
  return path.join(workspace().dataDir, KEY_FILE_NAME);
}

let cachedMasterKey: Buffer | null = null;

/** Drop the cached key. Tests use it after pointing the workspace elsewhere. */
export function resetVaultKeyCacheForTest(): void {
  cachedMasterKey = null;
}

function decodeKeyFile(guard: PathGuard, file: string): Buffer {
  const kind = containerKind(file);
  if (kind === 'v2') {
    throw new Error(
      `vault: ${file} is an AES container, but the master key cannot be stored AES-encrypted — restore it from a backup or re-import the data`,
    );
  }
  if (kind !== 'v1') throw new Error(`vault: ${file} is not a DPAPI container (not a usable master key)`);
  const tmp = tmpPlainName(file);
  try {
    legacyUnprotect(guard, file, tmp);
    const key = fs.readFileSync(tmp);
    if (key.length !== KEY_BYTES) {
      throw new Error(`vault: master key has ${key.length} bytes, expected ${KEY_BYTES}`);
    }
    return key;
  } finally {
    burnFileSync(tmp);
  }
}

/**
 * The process-wide master key. Created on first use under a file lock, then
 * cached for the rest of the process's life.
 *
 * A key file that EXISTS but cannot be read is a hard error, never a reason to
 * generate a fresh key: every container already on disk is encrypted with the
 * old one, so replacing it would silently turn the user's memory into garbage.
 */
export function masterKey(guard: PathGuard): Buffer {
  if (cachedMasterKey) return cachedMasterKey;
  const file = guard.assert(vaultKeyPath());
  if (fs.existsSync(file)) {
    cachedMasterKey = decodeKeyFile(guard, file);
    return cachedMasterKey;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const created = withFileLock(file, (): Buffer | null => {
    if (fs.existsSync(file)) return null; // another process created it first
    const plain = tmpPlainName(file);
    const enc = tmpEncName(file);
    try {
      const key = randomBytes(KEY_BYTES);
      fs.writeFileSync(plain, key);
      legacyProtect(guard, plain, enc);
      // Open the container we are about to publish: a master key nobody can
      // unwrap is dead data, so verify the round trip before it goes live.
      const check = tmpPlainName(file);
      try {
        legacyUnprotect(guard, enc, check);
        if (!fs.readFileSync(check).equals(key)) throw new Error('vault: master key round-trip mismatch');
      } finally {
        burnFileSync(check);
      }
      fs.renameSync(enc, file);
      return key;
    } finally {
      burnFileSync(plain);
      fs.rmSync(enc, { force: true });
    }
  });
  cachedMasterKey = created ?? decodeKeyFile(guard, file);
  return cachedMasterKey;
}

/** Ciphertext of any container generation -> plaintext bytes. */
function readContainer(guard: PathGuard, file: string): Buffer {
  const kind = containerKind(file);
  if (kind === 'v2') return decryptBlob(masterKey(guard), fs.readFileSync(file));
  if (kind === 'v1') {
    const tmp = tmpPlainName(file);
    try {
      legacyUnprotect(guard, file, tmp);
      return fs.readFileSync(tmp);
    } finally {
      burnFileSync(tmp);
    }
  }
  return fs.readFileSync(file);
}

/** Plaintext bytes -> KHBV2 container, renamed into place (atomic replace). */
function writeContainer(guard: PathGuard, file: string, data: Buffer): void {
  const f = guard.assert(file);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const enc = tmpEncName(f);
  try {
    fs.writeFileSync(enc, encryptBlob(masterKey(guard), data));
    fs.renameSync(enc, f);
  } finally {
    fs.rmSync(enc, { force: true });
  }
}

/**
 * Read JSON: encrypted files are decrypted in memory (or through a shredded
 * data/tmp window for legacy containers); plaintext stays compatible.
 */
export function loadJson<T>(guard: PathGuard, file: string): T | null {
  const f = guard.assert(file);
  if (!fs.existsSync(f)) return null;
  if (containerKind(f) === 'plain') {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8')) as T;
    } catch {
      return null;
    }
  }
  // Encrypted file: a failure here is a damaged container or a foreign master
  // key. Report it instead of "no file" — callers treat null as an empty store
  // and would overwrite the user's data with a fresh one.
  return JSON.parse(readContainer(guard, f).toString('utf8')) as T;
}

/** Write JSON as a KHBV2 container. */
export function saveJson(guard: PathGuard, file: string, value: unknown): void {
  writeContainer(guard, file, Buffer.from(JSON.stringify(value, null, 2), 'utf8'));
}

/** Read a plaintext UTF-8 text file (ledger etc.), with fallback. */
export function readText(guard: PathGuard, file: string, fallback = ''): string {
  const f = guard.assert(file);
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return fallback;
  }
}

/** Write a plaintext UTF-8 text file atomically (ledger etc.). */
export function writeText(guard: PathGuard, file: string, content: string): void {
  const f = guard.assert(file);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = tmpPlainName(f);
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, f);
  } finally {
    burnFileSync(tmp);
  }
}

/** Read an encrypted UTF-8 text file (e.g. seeds.jsonl). Missing -> null. */
export function loadEncryptedText(guard: PathGuard, file: string): string | null {
  const f = guard.assert(file);
  if (!fs.existsSync(f)) return null;
  return readContainer(guard, f).toString('utf8');
}

/** Write an encrypted UTF-8 text file as a KHBV2 container. */
export function saveEncryptedText(guard: PathGuard, file: string, content: string): void {
  writeContainer(guard, file, Buffer.from(content, 'utf8'));
}

/** Encrypt any binary file (e.g. screenshot): inFile -> encrypted outFile. */
export function encryptFile(guard: PathGuard, inFile: string, outFile: string): void {
  const inPath = guard.assert(inFile);
  writeContainer(guard, outFile, fs.readFileSync(inPath));
}

/**
 * Decrypt an encrypted file to a plaintext output (caller must place the
 * output under data/tmp and delete it after use; "use then burn" discipline).
 */
export function decryptFile(guard: PathGuard, inFile: string, outFile: string): void {
  const inPath = guard.assert(inFile);
  const outPath = guard.assert(outFile);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const data = readContainer(guard, inPath);
  const tmp = tmpPlainName(outPath);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, outPath);
  } finally {
    burnFileSync(tmp);
  }
}

export interface VaultUpgradeResult {
  /** Files whose header was inspected. */
  scanned: number;
  /** Legacy KHBV1 containers rewritten as KHBV2. */
  upgraded: number;
  /** Files that could not be migrated (the original file is left untouched). */
  failed: { file: string; reason: string }[];
}

/** Rewrite one legacy container as KHBV2. Returns false when there is nothing to do. */
export function upgradeVaultFile(guard: PathGuard, file: string): boolean {
  const f = guard.assert(file);
  if (containerKind(f) !== 'v1') return false;
  const data = readContainer(guard, f); // DPAPI unwrap (throws if it is not ours)
  writeContainer(guard, f, data); // AES-GCM wrap; the rename replaces the original
  return true;
}

/**
 * Walk every file under the data dir and rewrite legacy containers in place, so
 * an upgraded plugin stops paying a PowerShell process per legacy file. The
 * tmp scratch dir and the master key itself are left alone.
 */
export function upgradeVaultTree(guard: PathGuard, dataDir: string): VaultUpgradeResult {
  const result: VaultUpgradeResult = { scanned: 0, upgraded: 0, failed: [] };
  for (const rel of matchFilesRecursive(dataDir, /./)) {
    if (rel === KEY_FILE_NAME || rel.startsWith('tmp/') || rel.startsWith('tmp\\')) continue;
    const abs = path.join(dataDir, rel.split('/').join(path.sep));
    try {
      result.scanned += 1;
      if (upgradeVaultFile(guard, abs)) result.upgraded += 1;
    } catch (e) {
      result.failed.push({ file: rel, reason: (e as Error).message });
    }
  }
  return result;
}
