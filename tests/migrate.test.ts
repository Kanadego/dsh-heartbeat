import { sandboxDir } from './_sandbox.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import { appendEntry, ledgerFilePath, readLedger } from '../src/ledger/ledger.js';
import { savePool, loadPool, seedsFilePath } from '../src/seeds/pool.js';
import { inboxAppend } from '../src/profile/inbox.js';
import {
  collectMigrationEntries,
  encryptContainer,
  decryptContainer,
  applyMigrationEntries,
  isMigratablePath,
  MIGRATE_MAGIC,
  MIGRATE_MAX_FILES,
} from '../src/vault/migrate.js';

let sandbox = '';

function freshWorkspace(label: string): ReturnType<typeof workspace> {
  sandbox = sandboxDir(`hb-mig-${label}-`);
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  return workspace();
}

beforeEach(() => {
  freshWorkspace('a');
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
});

test('container roundtrip: encrypt/decrypt preserves entries; wrong passphrase is loud', () => {
  const guard = createPathGuard(workspace().dataDir);
  const entries = [
    { path: 'ledger.md', encrypted: false, content: '# 账本\n- 一条' },
    { path: 'seeds.jsonl', encrypted: true, content: '种子内容' },
  ];
  const container = encryptContainer(entries, '口令ABC', new Date('2026-10-05T12:00:00Z'));
  assert.equal((JSON.parse(container) as { magic: string }).magic, MIGRATE_MAGIC);
  const opened = decryptContainer(container, '口令ABC');
  assert.equal(opened.files.length, 2);
  assert.deepEqual(opened.files[1], { path: 'seeds.jsonl', encrypted: true, content: '种子内容' });
  assert.throws(() => decryptContainer(container, '错误口令'), /wrong passphrase|口令/);
  assert.throws(() => decryptContainer('not json', '口令ABC'), /container/);
});

test('v1.9.0: decrypt honors the container kdf.N instead of assuming the current default', () => {
  const entries = [{ path: 'ledger.md', encrypted: false, content: '# 账本\n- 一条' }];
  const container = encryptContainer(entries, 'pw', new Date('2026-10-05T12:00:00Z'));
  const withN = (n: number): string => {
    const doc = JSON.parse(container) as { kdf: { N?: number } };
    doc.kdf.N = n;
    return JSON.stringify(doc);
  };

  // the container's N is validated before any crypto runs
  assert.throws(() => decryptContainer(withN(999), 'pw'), /invalid kdf parameters/); // not a power of two
  assert.throws(() => decryptContainer(withN(1 << 20), 'pw'), /outside the supported range/); // far too big

  // ...and it is the one actually used for key derivation: a container that
  // claims a different (valid) N no longer opens with the current default —
  // under the old code the outer N was ignored, so this returned the plaintext
  assert.throws(() => decryptContainer(withN(1 << 15), 'pw'), /wrong passphrase|corrupted/);

  // untouched container still round-trips
  assert.equal(decryptContainer(container, 'pw').files[0]!.content, '# 账本\n- 一条');
});

test('export collects plaintext + DPAPI files; import restores them re-encrypted with local DPAPI', () => {
  // ── source machine: real stores ──
  const srcPaths = workspace();
  const srcGuard = createPathGuard(srcPaths.dataDir);
  appendEntry(srcGuard, ledgerFilePath(srcPaths.dataDir), '从旧机器带来的事项', Date.parse('2026-10-01T10:00:00'));
  inboxAppend(srcGuard, path.join(srcPaths.dataDir, 'profile_inbox.jsonl'), { kind: 'chat', at: new Date().toISOString(), ref: 't#1', note: '观察条目' });
  savePool(srcGuard, seedsFilePath(srcPaths.dataDir), {
    seq: 1,
    seeds: [{
      id: 's1', text: '迁移的素材', topic: 't', tag: 'news', source: 'hand', category: 'topic',
      confidence: 0.8, protected: false, used: 0, bornAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(), lastUsedAt: null,
      lastEvidenceAt: new Date().toISOString(), status: 'active',
    }],
  } as never);

  const { entries, progress } = collectMigrationEntries(srcGuard, srcPaths);
  assert.ok(progress.packed.includes('ledger.md'));
  assert.ok(progress.packed.includes('seeds.jsonl'));
  const ledgerEntry = entries.find((e) => e.path === 'ledger.md')!;
  const seedsEntry = entries.find((e) => e.path === 'seeds.jsonl')!;
  assert.equal(ledgerEntry.encrypted, false);
  assert.equal(seedsEntry.encrypted, true); // DPAPI on disk, decrypted in-container

  const container = encryptContainer(entries, 'pw', new Date());

  // ── target machine: fresh workspace, restore ──
  const dstPaths = freshWorkspace('b');
  const dstGuard = createPathGuard(dstPaths.dataDir);
  // a pre-existing ledger must be backed up, not silently replaced
  fs.writeFileSync(ledgerFilePath(dstPaths.dataDir), '# 账本\n- 旧机器上的旧事项\n', 'utf8');

  const opened = decryptContainer(container, 'pw');
  const result = applyMigrationEntries(dstGuard, dstPaths, opened.files);
  assert.ok(result.restored.includes('ledger.md'));
  assert.ok(result.backedUp.includes('ledger.md'));
  assert.equal(result.skipped.length, 0);

  // ledger restored (old content backed aside, new content in place)
  const { entries: ledgerEntries } = readLedger(dstGuard, ledgerFilePath(dstPaths.dataDir));
  assert.ok(ledgerEntries.some((e) => e.text === '从旧机器带来的事项'));
  const backup = fs.readdirSync(dstPaths.dataDir).find((f) => f.startsWith('ledger.md.bak-migrate-'));
  assert.ok(backup, 'overwritten ledger is backed up');

  // seeds restored AND re-encrypted with the LOCAL DPAPI (loadPool proves it)
  const db = loadPool(dstGuard, seedsFilePath(dstPaths.dataDir));
  assert.equal(db.seeds[0]!.text, '迁移的素材');
  // guard-dodging paths are refused, never written
  const evil = applyMigrationEntries(dstGuard, dstPaths, [{ path: '../evil.json', encrypted: false, content: 'x' }]);
  assert.deepEqual(evil.skipped, ['../evil.json']);
  assert.equal(evil.restored.length, 0);
});
test('HB-06: one entry that cannot be staged aborts the whole import', () => {
  const paths = freshWorkspace('hb06');
  const guard = createPathGuard(paths.dataDir);
  fs.writeFileSync(ledgerFilePath(paths.dataDir), '# 账本\n- 原来的事项\n', 'utf8');
  const result = applyMigrationEntries(guard, paths, [
    { path: 'ledger.md', encrypted: false, content: '# 账本\n- 新机器带来的事项\n' },
    { path: '../evil.json', encrypted: false, content: 'x' },
  ]);
  assert.deepEqual(result.restored, [], 'a healthy entry is not committed either');
  assert.deepEqual(result.backedUp, []);
  assert.deepEqual(result.skipped, ['../evil.json']);
  assert.match(result.error ?? '', /nothing was imported/);
  // the local ledger is untouched: no half-migrated memory
  assert.match(fs.readFileSync(ledgerFilePath(paths.dataDir), 'utf8'), /原来的事项/);
  const leftovers = fs.readdirSync(paths.dataDir).filter((f) => f.includes('.incoming-'));
  assert.deepEqual(leftovers, [], 'staged copies are cleaned up');
});

test('HB-18: a container may only name files an export can produce', () => {
  assert.equal(isMigratablePath('ledger.md'), true);
  assert.equal(isMigratablePath('profile_journal.archive-20261017.jsonl'), true);
  assert.equal(isMigratablePath('weekly/2026-10-17.json'), true);
  assert.equal(isMigratablePath('settings/policy.json'), false);
  assert.equal(isMigratablePath('gate.json'), false);
  assert.equal(isMigratablePath('vault.key'), false);
  assert.equal(isMigratablePath('weekly/sub/x.json'), false);
  assert.equal(isMigratablePath('profile_journal.archive-x.jsonl'), false);

  const paths = freshWorkspace('hb18');
  const guard = createPathGuard(paths.dataDir);
  const result = applyMigrationEntries(guard, paths, [
    { path: 'settings/policy.json', encrypted: false, content: '{}' },
    { path: 'vault.key', encrypted: false, content: 'nope' },
  ]);
  assert.equal(result.restored.length, 0);
  assert.equal(result.skipped.length, 2);
  assert.equal(fs.existsSync(path.join(paths.dataDir, 'settings', 'policy.json')), false);
  assert.equal(fs.existsSync(path.join(paths.dataDir, 'vault.key')), false);
});

test('HB-18: a container listing an absurd number of files is refused', () => {
  const many = Array.from({ length: MIGRATE_MAX_FILES + 1 }, (_v, i) => ({
    path: 'weekly/2026-01-01.json', encrypted: false, content: String(i),
  }));
  const container = encryptContainer(many, 'pw', new Date());
  assert.throws(() => decryptContainer(container, 'pw'), /over the 5000 limit/);
});
