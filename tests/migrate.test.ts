import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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
  MIGRATE_MAGIC,
} from '../src/vault/migrate.js';

let sandbox = '';

function freshWorkspace(label: string): ReturnType<typeof workspace> {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `hb-mig-${label}-`));
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
