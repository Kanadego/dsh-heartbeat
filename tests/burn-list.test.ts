// H-19: the burn list and the migrate list must not drift apart again. v1
// shipped two hardcoded lists and one drifted; v1.9.0 then added memory files
// (seed reports, preference stats, journal snapshot, cursors, weekly reports)
// that the burn list never learned about. These tests pin the two invariants
// that cost us the most: everything migrated is also burned, and the journal
// rotation shards (PLAINTEXT profile history) are actually removed.

import { sandboxDir } from './_sandbox.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createPathGuard } from '../src/core/path-guard.js';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { BURN_LIST, executeBurn } from '../src/vault/burn-list.js';
import { MIGRATE_FILES } from '../src/vault/migrate.js';

test('H-19: every migrated memory file is also on the burn list', () => {
  const files = new Set(BURN_LIST.flatMap((t) => (t.file ? [t.file] : [])));
  const prefixes = BURN_LIST.flatMap((t) => (t.prefix ? [t.prefix] : []));
  const dirs = BURN_LIST.flatMap((t) => (t.dir ? [t.dir] : []));
  const covered = (f: string): boolean =>
    files.has(f) || prefixes.some((p) => f.startsWith(p)) || dirs.some((d) => f.startsWith(`${d}/`));
  assert.deepEqual(
    MIGRATE_FILES.filter((f) => !covered(f)),
    [],
    'MIGRATE_FILES entries missing from BURN_LIST',
  );
});

test('HB-07: a burn shreds migration backups and staging leftovers, subdirs included', () => {
  const dir = sandboxDir('hb-burn-');
  process.env.HEARTBEAT_DATA_DIR = path.join(dir, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  try {
    const guard = createPathGuard(workspace().dataDir);
    const dataDir = workspace().dataDir;
    // every file applyMigrationEntries overwrites is copied to
    // <abs>.bak-migrate-<stamp> — the OLD memory, sitting right next to it,
    // and the staging leftover is the same data, only younger
    const top = path.join(dataDir, 'ledger.md.bak-migrate-20261017000000');
    const nested = path.join(dataDir, 'weekly', 'profile.json.bak-migrate-20261017000000');
    const staging = path.join(dataDir, 'profile_journal.jsonl.incoming-20261017000000');
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(top, 'x', 'utf8');
    fs.writeFileSync(nested, 'x', 'utf8');
    fs.writeFileSync(staging, 'x', 'utf8');

    const res = executeBurn(guard, workspace());
    assert.equal(fs.existsSync(top), false);
    assert.equal(fs.existsSync(nested), false);
    assert.equal(fs.existsSync(staging), false);
    assert.ok(res.burned.includes('ledger.md.bak-migrate-20261017000000'));
    assert.ok(res.burned.includes('weekly/profile.json.bak-migrate-20261017000000'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.HEARTBEAT_DATA_DIR;
    resetWorkspaceForTest();
  }
});

test('H-19: a burn shreds the journal archive shards too', () => {
  const dir = sandboxDir('hb-burn-');
  process.env.HEARTBEAT_DATA_DIR = path.join(dir, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  try {
    const guard = createPathGuard(workspace().dataDir);
    const shard = path.join(workspace().dataDir, 'profile_journal.archive-20261005T040000.jsonl');
    fs.writeFileSync(shard, '{"ts":"2026-10-05T04:00:00.000Z","applied":[]}\n', 'utf8');

    const res = executeBurn(guard, workspace());
    assert.ok(res.burned.includes('profile_journal.archive-20261005T040000.jsonl'));
    assert.equal(fs.existsSync(shard), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.HEARTBEAT_DATA_DIR;
    resetWorkspaceForTest();
  }
});
