// H-19: the burn list and the migrate list must not drift apart again. v1
// shipped two hardcoded lists and one drifted; v1.9.0 then added memory files
// (seed reports, preference stats, journal snapshot, cursors, weekly reports)
// that the burn list never learned about. These tests pin the two invariants
// that cost us the most: everything migrated is also burned, and the journal
// rotation shards (PLAINTEXT profile history) are actually removed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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

test('H-19: a burn shreds the journal archive shards too', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-burn-'));
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
