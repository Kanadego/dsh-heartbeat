// Vault containers (v2.0): AES-256-GCM payloads keyed by a DPAPI-wrapped
// master key, with the legacy KHBV1 container still readable and upgradable.
import { sandboxDir } from './_sandbox.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import {
  containerKind,
  isEncrypted,
  loadEncryptedText,
  loadJson,
  resetVaultKeyCacheForTest,
  saveEncryptedText,
  saveJson,
  upgradeOneLegacyVaultFile,
  upgradeVaultFile,
  upgradeVaultTree,
  vaultKeyPath,
  encryptFile,
  decryptFile,
  writeText,
  readText,
} from '../src/vault/vault.js';

let sandbox = '';

beforeEach(() => {
  sandbox = sandboxDir('hb-vault-');
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  resetVaultKeyCacheForTest();
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
  resetVaultKeyCacheForTest();
});

/** A genuine legacy container, made by the bundled DPAPI script. */
function writeLegacyContainer(target: string, payload: string): void {
  const plain = path.join(workspace().tmpDir, `legacy-${Math.random().toString(36).slice(2)}.plain`);
  const enc = `${plain}.enc`;
  fs.writeFileSync(plain, payload);
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(workspace().assetsDir, 'vault.ps1'),
      'protect', '-InFile', plain, '-OutFile', enc],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(enc, target);
  fs.rmSync(plain, { force: true });
  fs.rmSync(enc, { force: true });
}

test('saveJson writes an AES-GCM container (KHBV2) with no plaintext payload', () => {
  const guard = createPathGuard(workspace().dataDir);
  const file = path.join(workspace().dataDir, 'state.json');
  saveJson(guard, file, { hello: 'world', n: 42 });
  assert.equal(isEncrypted(file), true);
  assert.equal(containerKind(file), 'v2');
  const raw = fs.readFileSync(file);
  assert.equal(raw.subarray(0, 5).toString('ascii'), 'KHBV2');
  // Ciphertext must not contain the plaintext JSON.
  assert.equal(raw.includes(Buffer.from('"hello"')), false);
  // The master key is the one file that still needs DPAPI (executed once).
  assert.equal(containerKind(vaultKeyPath()), 'v1');
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

test('a flipped ciphertext byte fails authentication instead of returning garbage', () => {
  const guard = createPathGuard(workspace().dataDir);
  const file = path.join(workspace().dataDir, 'browse.json');
  saveJson(guard, file, { n: 1 });
  const raw = fs.readFileSync(file);
  const last = raw.length - 1;
  raw[last] = (raw[last] ?? 0) ^ 0xff;
  fs.writeFileSync(file, raw);
  assert.throws(() => loadEncryptedText(guard, file), /authenticate|Unsupported state/i);
  assert.throws(() => loadJson(guard, file), /authenticate|Unsupported state/i);
});

test('legacy KHBV1 files stay readable and upgrade in place', () => {
  const guard = createPathGuard(workspace().dataDir);
  const file = path.join(workspace().dataDir, 'preference.json');
  writeLegacyContainer(file, '{"theme":"abyss"}');
  assert.equal(containerKind(file), 'v1');
  assert.deepEqual(loadJson(guard, file), { theme: 'abyss' });

  assert.equal(upgradeVaultFile(guard, file), true);
  assert.equal(containerKind(file), 'v2');
  assert.deepEqual(loadJson(guard, file), { theme: 'abyss' });
  assert.equal(upgradeVaultFile(guard, file), false); // already current
});

test('upgradeVaultTree rewrites legacy files, skips scratch and the key', () => {
  const guard = createPathGuard(workspace().dataDir);
  saveJson(guard, path.join(workspace().dataDir, 'gate.json'), { a: 1 }); // creates + caches the key
  writeLegacyContainer(path.join(workspace().dataDir, 'weekly', 'report-1.json'), '{"w":1}');
  writeLegacyContainer(path.join(workspace().dataDir, 'seeds.jsonl'), 'line\n');
  writeLegacyContainer(path.join(workspace().tmpDir, 'scratch.json'), '{"tmp":1}');

  const r = upgradeVaultTree(guard, workspace().dataDir);
  assert.deepEqual(r.failed, []);
  assert.equal(r.upgraded, 2);
  assert.equal(containerKind(path.join(workspace().dataDir, 'weekly', 'report-1.json')), 'v2');
  assert.equal(containerKind(path.join(workspace().dataDir, 'seeds.jsonl')), 'v2');
  assert.equal(loadEncryptedText(guard, path.join(workspace().dataDir, 'seeds.jsonl')), 'line\n');
  assert.equal(containerKind(path.join(workspace().tmpDir, 'scratch.json')), 'v1');
  assert.equal(containerKind(vaultKeyPath()), 'v1');
});

test('the maintenance sweep converts one legacy container per call', () => {
  const guard = createPathGuard(workspace().dataDir);
  saveJson(guard, path.join(workspace().dataDir, 'gate.json'), { a: 1 }); // creates the key
  writeLegacyContainer(path.join(workspace().dataDir, 'a-first.json'), '{"n":1}');
  writeLegacyContainer(path.join(workspace().dataDir, 'b-second.json'), '{"n":2}');

  const first = upgradeOneLegacyVaultFile(guard, workspace().dataDir);
  assert.ok(first && first.endsWith('.json'));
  const second = upgradeOneLegacyVaultFile(guard, workspace().dataDir);
  assert.ok(second && second !== first);
  assert.equal(upgradeOneLegacyVaultFile(guard, workspace().dataDir), null); // drained
  assert.equal(containerKind(path.join(workspace().dataDir, 'a-first.json')), 'v2');
  assert.equal(containerKind(path.join(workspace().dataDir, 'b-second.json')), 'v2');
  assert.deepEqual(loadJson(guard, path.join(workspace().dataDir, 'a-first.json')), { n: 1 });
});

test('the sweep skips a container it cannot migrate instead of blocking on it', () => {
  const guard = createPathGuard(workspace().dataDir);
  saveJson(guard, path.join(workspace().dataDir, 'gate.json'), { a: 1 });
  const broken = path.join(workspace().dataDir, 'a-broken.json');
  fs.writeFileSync(broken, Buffer.concat([Buffer.from('KHBV1', 'ascii'), Buffer.from('garbage')]));
  writeLegacyContainer(path.join(workspace().dataDir, 'b-good.json'), '{"ok":true}');

  assert.equal(upgradeOneLegacyVaultFile(guard, workspace().dataDir), 'b-good.json');
  assert.equal(containerKind(broken), 'v1'); // left exactly as it was
});

test('an unreadable master key is a hard error, never a freshly generated one', () => {
  const guard = createPathGuard(workspace().dataDir);
  const file = path.join(workspace().dataDir, 'gate.json');
  saveJson(guard, file, { a: 1 });
  fs.writeFileSync(vaultKeyPath(), 'not a container');
  resetVaultKeyCacheForTest();
  assert.throws(() => loadEncryptedText(guard, file), /not a DPAPI container/);
  // The damaged key is left exactly as it was: replacing it would orphan the data.
  assert.equal(fs.readFileSync(vaultKeyPath(), 'utf8'), 'not a container');
});

test('plaintext temp windows live in data/tmp, never beside the target', () => {
  const guard = createPathGuard(workspace().dataDir);
  const file = path.join(workspace().dataDir, 'seeds.json');
  saveJson(guard, file, { v: 1 });
  assert.deepEqual(loadJson(guard, file), { v: 1 });
  const dataDirFiles = fs.readdirSync(workspace().dataDir).filter((f) => f.endsWith('.tmp') || f.startsWith('.'));
  assert.deepEqual(dataDirFiles, []);
  // The AES path does not even need a plaintext window.
  const windows = fs.readdirSync(workspace().tmpDir).filter((f) => f.endsWith('.plain'));
  assert.deepEqual(windows, []);
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
  assert.equal(containerKind(enc), 'v2');
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

test('crash debris in data/tmp is burned on first use, live scratch is left alone (低优先级 review)', () => {
  const guard = createPathGuard(workspace().dataDir);
  const tmp = workspace().tmpDir;
  fs.mkdirSync(tmp, { recursive: true });
  const stale = path.join(tmp, '.crashed.plain');
  const live = path.join(tmp, '.running.enc');
  fs.writeFileSync(stale, 'plaintext window left behind by a kill');
  fs.writeFileSync(live, 'a window another process is using right now');
  const past = new Date(Date.now() - 11 * 60_000);
  fs.utimesSync(stale, past, past);

  // The sweep rides on the first master-key use of the process.
  saveJson(guard, path.join(workspace().dataDir, 'seeds.json'), { v: 1 });
  assert.equal(fs.existsSync(stale), false, 'crash debris must be burned, not just unlinked');
  assert.equal(fs.existsSync(live), true, 'a fresh scratch file belongs to someone else');
});
