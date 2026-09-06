import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import { isEncrypted, loadJson, saveJson, encryptFile, decryptFile, writeText, readText } from '../src/vault/vault.js';

let sandbox = '';

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-vault-'));
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
});

test('saveJson writes a DPAPI-encrypted file with KHBV1 header', () => {
  const guard = createPathGuard(workspace().dataDir);
  const file = path.join(workspace().dataDir, 'state.json');
  saveJson(guard, file, { hello: 'world', n: 42 });
  assert.equal(isEncrypted(file), true);
  const raw = fs.readFileSync(file);
  assert.equal(raw.subarray(0, 5).toString('ascii'), 'KHBV1');
  // Ciphertext must not contain the plaintext JSON.
  assert.equal(raw.includes(Buffer.from('"hello"')), false);
});

test('loadJson round-trips through encryption', () => {
  const guard = createPathGuard(workspace().dataDir);
  const file = path.join(workspace().dataDir, 'state.json');
  saveJson(guard, file, { list: [1, 2, 3], nested: { ok: true } });
  assert.deepEqual(loadJson(guard, file), { list: [1, 2, 3], nested: { ok: true } });
});

test('loadJson returns null for missing files and reads plaintext for compatibility', () => {
  const guard = createPathGuard(workspace().dataDir);
  assert.equal(loadJson(guard, path.join(workspace().dataDir, 'missing.json')), null);
  const plain = path.join(workspace().dataDir, 'plain.json');
  fs.writeFileSync(plain, '{"legacy":true}', 'utf8');
  assert.deepEqual(loadJson(guard, plain), { legacy: true });
});

test('plaintext temp windows live in data/tmp, never beside the target', () => {
  const guard = createPathGuard(workspace().dataDir);
  const file = path.join(workspace().dataDir, 'seeds.json');
  saveJson(guard, file, { v: 1 });
  assert.deepEqual(loadJson(guard, file), { v: 1 });
  const dataDirFiles = fs.readdirSync(workspace().dataDir).filter((f) => f.endsWith('.tmp') || f.startsWith('.'));
  assert.deepEqual(dataDirFiles, []);
});

test('encryptFile / decryptFile round-trips binary content', () => {
  const guard = createPathGuard(workspace().dataDir);
  const src = path.join(workspace().dataDir, 'shot.bin');
  const enc = path.join(workspace().dataDir, 'shot.bin.enc');
  const dec = path.join(workspace().tmpDir, 'shot.bin');
  const bytes = Buffer.from([0, 1, 2, 250, 251, 255, 65, 66]);
  fs.writeFileSync(src, bytes);
  encryptFile(guard, src, enc);
  assert.equal(isEncrypted(enc), true);
  decryptFile(guard, enc, dec);
  assert.deepEqual(fs.readFileSync(dec), bytes);
  fs.rmSync(dec, { force: true });
});

test('text helpers stay plaintext (ledger charter)', () => {
  const guard = createPathGuard(workspace().dataDir);
  const file = path.join(workspace().dataDir, 'ledger.md');
  writeText(guard, file, '# 账本\n');
  assert.equal(isEncrypted(file), false);
  assert.equal(readText(guard, file), '# 账本\n');
  assert.equal(readText(guard, path.join(workspace().dataDir, 'nope.md'), 'fallback'), 'fallback');
});

test('vault rejects targets outside the workspace', () => {
  const guard = createPathGuard(workspace().dataDir);
  assert.throws(() => saveJson(guard, path.join(sandbox, 'outside.json'), {}), /outside workspace/);
  assert.throws(() => loadJson(guard, path.join(sandbox, 'outside.json')), /outside workspace/);
});
