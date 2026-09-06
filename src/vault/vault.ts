// Transparent encryption read/write layer (port of v1 lib/vault.mjs).
//
// Mechanism: Node <-> vault.ps1 hand off through temp files (plain text
// windows are millisecond-scale). v2 hardening over v1:
//   - plaintext temp files live ONLY under data/tmp (never beside targets);
//   - every path passes the workspace guard before reaching PowerShell;
//   - encrypted output lands via same-volume rename (atomic replace).
// Encryption failure is fail-closed: throw, never fall back to plaintext.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { PathGuard } from '../core/path-guard.js';
import { workspace } from '../core/paths.js';

const MAGIC = Buffer.from('KHBV1', 'ascii');
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

/** KHBV1 header check without reading the whole file. */
export function isEncrypted(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  const fd = fs.openSync(file, 'r');
  try {
    const hdr = Buffer.alloc(MAGIC.length);
    const read = fs.readSync(fd, hdr, 0, hdr.length, 0);
    return read === MAGIC.length && hdr.equals(MAGIC);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read JSON: encrypted files are decrypted to a data/tmp plaintext window
 * that is shredded immediately after parse; plaintext stays compatible.
 */
export function loadJson<T>(guard: PathGuard, file: string): T | null {
  const f = guard.assert(file);
  if (!fs.existsSync(f)) return null;
  if (!isEncrypted(f)) {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8')) as T;
    } catch {
      return null;
    }
  }
  const tmp = tmpPlainName(f);
  try {
    runVault(guard, ['unprotect', '-InFile', f, '-OutFile', tmp]);
    return JSON.parse(fs.readFileSync(tmp, 'utf8')) as T;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Write JSON: plaintext window in data/tmp -> DPAPI encrypt -> atomic rename into place. */
export function saveJson(guard: PathGuard, file: string, value: unknown): void {
  const f = guard.assert(file);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const plain = tmpPlainName(f);
  const enc = tmpEncName(f);
  try {
    fs.writeFileSync(plain, JSON.stringify(value, null, 2), 'utf8');
    runVault(guard, ['protect', '-InFile', plain, '-OutFile', enc]);
    fs.renameSync(enc, f);
  } finally {
    fs.rmSync(plain, { force: true });
    fs.rmSync(enc, { force: true });
  }
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
    fs.rmSync(tmp, { force: true });
  }
}

/** Read an encrypted UTF-8 text file (e.g. seeds.jsonl). Missing -> null. */
export function loadEncryptedText(guard: PathGuard, file: string): string | null {
  const f = guard.assert(file);
  if (!fs.existsSync(f)) return null;
  if (!isEncrypted(f)) return fs.readFileSync(f, 'utf8');
  const tmp = tmpPlainName(f);
  try {
    runVault(guard, ['unprotect', '-InFile', f, '-OutFile', tmp]);
    return fs.readFileSync(tmp, 'utf8');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Write an encrypted UTF-8 text file atomically. */
export function saveEncryptedText(guard: PathGuard, file: string, content: string): void {
  const f = guard.assert(file);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const plain = tmpPlainName(f);
  const enc = tmpEncName(f);
  try {
    fs.writeFileSync(plain, content, 'utf8');
    runVault(guard, ['protect', '-InFile', plain, '-OutFile', enc]);
    fs.renameSync(enc, f);
  } finally {
    fs.rmSync(plain, { force: true });
    fs.rmSync(enc, { force: true });
  }
}

/** Encrypt any binary file (e.g. screenshot): inFile -> encrypted outFile. */
export function encryptFile(guard: PathGuard, inFile: string, outFile: string): void {
  const inPath = guard.assert(inFile);
  const outPath = guard.assert(outFile);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const enc = tmpEncName(outPath);
  try {
    runVault(guard, ['protect', '-InFile', inPath, '-OutFile', enc]);
    fs.renameSync(enc, outPath);
  } finally {
    fs.rmSync(enc, { force: true });
  }
}

/**
 * Decrypt an encrypted file to a plaintext output (caller must place the
 * output under data/tmp and delete it after use; "use then burn" discipline).
 */
export function decryptFile(guard: PathGuard, inFile: string, outFile: string): void {
  const inPath = guard.assert(inFile);
  const outPath = guard.assert(outFile);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  runVault(guard, ['unprotect', '-InFile', inPath, '-OutFile', outPath]);
}
