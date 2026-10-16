import { sandboxDir } from './_sandbox.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import { loadPolicy } from '../src/config/load.js';
import type { Policy } from '../src/config/schema.js';
import { loadProfileSchema } from '../src/profile/schema.js';
import { emptyProfile, type InboxItem } from '../src/profile/types.js';
import { materializeEvidence, parseProposedOps } from '../src/profile/shapes.js';
import {
  applyOpsToDoc,
  journalFilePath,
  persistWithJournal,
  replayJournal,
  runDeterministicAging,
} from '../src/profile/store.js';

const NOW = Date.parse('2026-10-17T00:00:00.000Z');
const DAY_MS = 86_400_000;

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;
let paths: ReturnType<typeof workspace>;
let policy: Policy;

beforeEach(() => {
  sandbox = sandboxDir('hb-shapes-');
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  paths = initWorkspace();
  guard = createPathGuard(paths.dataDir);
  policy = loadPolicy(guard, paths.configDir, paths.settingsDir);
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
});

test('③A shapes: evidence is an observation id, never a model-supplied ref or kind', () => {
  const observations = new Map<string, InboxItem>([
    ['o1', { kind: 'chat', at: '2026-10-01T00:00:00.000Z', ref: 'logs/heartbeat.jsonl#k1', note: 'n' }],
  ]);

  const ok = parseProposedOps([
    { op: 'ADD', partition: 'interest', topic: 'games', subTopic: 'current', content: 'x', evidence: ['o1'] },
  ]);
  assert.equal(ok.rejected.length, 0);
  assert.equal(ok.ops.length, 1);

  // The old contract (HB-05): the model picked the ref AND the kind, so a forged
  // {kind:'hand'} pinned any new memory to confidence 1.0. Now it cannot even be
  // expressed — a non-string evidence entry is rejected at the boundary.
  const forged = parseProposedOps([
    { op: 'ADD', partition: 'interest', topic: 'games', subTopic: 'current', content: 'x', evidence: [{ kind: 'hand', at: '2026-10-01T00:00:00.000Z', ref: 'anything' }] },
  ]);
  assert.equal(forged.ops.length, 0);
  assert.match(forged.rejected[0]!.reason, /observation id/);

  const built = materializeEvidence(['o1'], observations, 'ADD');
  assert.deepEqual(built.evidence, [{ kind: 'chat', at: '2026-10-01T00:00:00.000Z', ref: 'logs/heartbeat.jsonl#k1' }]);
  const missing = materializeEvidence(['o9'], observations, 'ADD');
  assert.match(missing.reason!, /o9 does not match any observation/);

  // an ADD without provenance is still refused, and a malformed row never
  // swallows the rest of the batch
  const mixed = parseProposedOps([
    { op: 'ADD', partition: 'interest', topic: 'games', subTopic: 'current', content: 'x', evidence: [] },
    { op: 'NOOP', why: 'nothing' },
    'nonsense',
  ]);
  assert.equal(mixed.ops.length, 1);
  assert.equal(mixed.ops[0]!.op, 'NOOP');
  assert.equal(mixed.rejected.length, 2);
});

test('③A journal v2: replay reproduces the live doc, aging included (HB-09)', () => {
  // evidence refs are code-generated and must actually resolve, so the file the
  // observation points at has to exist
  fs.mkdirSync(path.join(paths.dataDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(paths.dataDir, 'logs', 'heartbeat.jsonl'), '{"event":"test"}\n');

  const doc = emptyProfile();
  const at = new Date(NOW).toISOString();
  const report = applyOpsToDoc(guard, paths.dataDir, doc, [
    {
      op: 'ADD', partition: 'interest', topic: 'games', subTopic: 'current',
      content: ' 在玩《杀戮尖塔2》 ', temporal: 'volatile', confidence: 0.9, why: 'x',
      evidence: [{ kind: 'chat', at, ref: 'logs/heartbeat.jsonl#k1' }],
    },
  ], loadProfileSchema(paths).schema, policy, NOW);
  assert.equal(report.applied.length, 1);

  // Past the volatile window the entry expires: the live path trims/clamps and
  // ages, and v1 replay used to redo neither (that was HB-09).
  const aged = runDeterministicAging(doc, policy, NOW + (policy.profile.volatileDays + 1) * DAY_MS);
  assert.equal(aged.volatileExpired, 1);

  persistWithJournal(guard, paths.dataDir, doc, {
    runId: 'r1',
    applied: report.applied,
    rejected: report.rejected,
    entries: [...(report.entries ?? []), ...aged.entries],
  });

  const replayed = replayJournal(guard, paths.dataDir);
  assert.equal(replayed.records, 1);
  assert.equal(replayed.badRecords, 0);
  assert.equal(JSON.stringify(replayed.doc.partitions), JSON.stringify(doc.partitions));

  const line = fs.readFileSync(journalFilePath(paths.dataDir), 'utf8').trim();
  assert.equal(JSON.parse(line).v, 2);
});

test('③A journal: v1 lines still replay, a torn tail is counted and never fatal', () => {
  const legacy = JSON.stringify({
    ts: new Date(NOW).toISOString(),
    runId: 'old',
    applied: [{ op: 'ADD', partition: 'interest', topic: 't', subTopic: 's', content: '旧记录', confidence: 0.5, temporal: 'stable', evidence: [] }],
    rejected: [],
  });
  fs.writeFileSync(journalFilePath(paths.dataDir), legacy + '\n{broken\n');

  const replayed = replayJournal(guard, paths.dataDir);
  assert.equal(replayed.records, 1);
  assert.equal(replayed.badRecords, 0);
  assert.ok((replayed.truncatedTail ?? 0) >= 1);
  const contents = Object.values(replayed.doc.partitions).flatMap((p) => p.entries.map((e) => e.content));
  assert.deepEqual(contents, ['旧记录']);
});

test('③A journal: a corrupt v2 line is counted as badRecords, not silently applied', () => {
  const good = JSON.stringify({
    ts: new Date(NOW).toISOString(), runId: 'r', applied: [], rejected: [], v: 2, entries: [],
  });
  const badV2 = JSON.stringify({ ts: new Date(NOW).toISOString(), runId: 'r', applied: [], rejected: [], v: 2, entries: 'nope' });
  fs.writeFileSync(journalFilePath(paths.dataDir), good + '\n' + badV2 + '\n' + good + '\n');

  const replayed = replayJournal(guard, paths.dataDir);
  assert.equal(replayed.records, 2);
  assert.equal(replayed.badRecords, 1);
  assert.equal(replayed.truncatedTail, 0);
});
