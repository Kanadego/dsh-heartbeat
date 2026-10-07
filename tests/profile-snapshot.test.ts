import { sandboxDir } from './_sandbox.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import { emptyProfile, type ProfileDoc } from '../src/profile/types.js';
import { persistWithJournal, replayJournal, verifyProfile, rebuildProfile, journalFilePath } from '../src/profile/store.js';
import { snapshotDue, snapshotProfile, SNAPSHOT_THRESHOLD } from '../src/profile/snapshot.js';

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;

beforeEach(() => {
  sandbox = sandboxDir('hb-snap-');
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  guard = createPathGuard(workspace().dataDir);
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
});

const addOp = (content: string) => ({
  runId: content,
  applied: [{ op: 'ADD', partition: 'interest', topic: 't', subTopic: 's', content, confidence: 0.5, temporal: 'stable', evidence: [], assignedId: content.slice(0, 4) } as never],
  rejected: [],
});

const strip = (doc: ProfileDoc): string =>
  JSON.stringify(doc.partitions, (k, v) => (['id', 'supersededBy', 'validFrom', 'createdAt', 'updatedAt', 'retiredAt'].includes(k) ? '<norm>' : v));

test('snapshot folds the journal: live empties, archive appears, replay is unchanged', () => {
  const paths = workspace();
  persistWithJournal(guard, paths.dataDir, emptyProfile(), addOp('喜欢天文摄影'));
  persistWithJournal(guard, paths.dataDir, emptyProfile(), addOp('在折腾播客'));
  const replayBefore = replayJournal(guard, paths.dataDir);
  assert.equal(replayBefore.records, 2);

  const report = snapshotProfile(guard, paths.dataDir);
  assert.equal(report.ok, true);
  assert.equal(report.folded, 2);
  assert.ok(report.archiveFile!.startsWith('profile_journal.archive-'));
  assert.equal(fs.readFileSync(journalFilePath(paths.dataDir), 'utf8'), ''); // live journal emptied

  const replayAfter = replayJournal(guard, paths.dataDir);
  assert.equal(strip(replayAfter.doc), strip(replayBefore.doc));
  // rebuild now works FROM the basepoint: disk view gets rebuilt, verify agrees
  rebuildProfile(guard, paths.dataDir);
  assert.equal(verifyProfile(guard, paths.dataDir).ok, true);
});

test('records written after a snapshot replay on top of the basepoint', () => {
  const paths = workspace();
  persistWithJournal(guard, paths.dataDir, emptyProfile(), addOp('第一条'));
  snapshotProfile(guard, paths.dataDir);
  persistWithJournal(guard, paths.dataDir, emptyProfile(), addOp('快照后新增'));
  const replayed = replayJournal(guard, paths.dataDir);
  const contents = Object.values(replayed.doc.partitions).flatMap((p) => p.entries.map((e) => e.content));
  assert.deepEqual(contents.sort(), ['快照后新增', '第一条'].sort());
});

test('two successive snapshots keep the replay consistent', () => {
  const paths = workspace();
  persistWithJournal(guard, paths.dataDir, emptyProfile(), addOp('第一批'));
  snapshotProfile(guard, paths.dataDir);
  persistWithJournal(guard, paths.dataDir, emptyProfile(), addOp('第二批'));
  snapshotProfile(guard, paths.dataDir);
  const replayed = replayJournal(guard, paths.dataDir);
  const contents = Object.values(replayed.doc.partitions).flatMap((p) => p.entries.map((e) => e.content));
  assert.deepEqual(contents.sort(), ['第二批', '第一批'].sort());
  rebuildProfile(guard, paths.dataDir);
  assert.equal(verifyProfile(guard, paths.dataDir).ok, true);
});

test('snapshotDue fires at the threshold; empty/absent journal never fires', () => {
  const paths = workspace();
  assert.equal(snapshotDue(guard, paths.dataDir).needed, false);
  const line = JSON.stringify({ ts: new Date().toISOString(), runId: 'r', applied: [], rejected: [] });
  fs.writeFileSync(journalFilePath(paths.dataDir), Array.from({ length: SNAPSHOT_THRESHOLD }, () => line).join('\n') + '\n');
  assert.equal(snapshotDue(guard, paths.dataDir).needed, true);
  assert.equal(snapshotDue(guard, paths.dataDir).lines, SNAPSHOT_THRESHOLD);
});
