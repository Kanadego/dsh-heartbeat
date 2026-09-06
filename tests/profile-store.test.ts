import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import { loadPolicy } from '../src/config/load.js';
import type { Policy } from '../src/config/schema.js';
import { loadProfileSchema } from '../src/profile/schema.js';
import {
  applyOpsToDoc,
  loadProfile,
  persistWithJournal,
  rebuildProfile,
  runDeterministicAging,
  verifyProfile,
  journalFilePath,
  profileFilePath,
} from '../src/profile/store.js';
import { emptyProfile, type ProfileOp } from '../src/profile/types.js';
import { appendAuditLine } from '../src/core/audit-log.js';

const NOW = Date.parse('2026-09-06T12:00:00.000Z');
const DAY = 86_400_000;

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;
let policy: Policy;
let schema: ReturnType<typeof loadProfileSchema>;

const ev = (kind: 'chat' | 'screen' | 'browse' = 'chat', atMs = NOW) => ({
  kind, at: new Date(atMs).toISOString(), ref: `logs/heartbeat.jsonl#${kind}-test`,
});

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-profile-'));
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  guard = createPathGuard(workspace().dataDir);
  policy = loadPolicy(guard, workspace().configDir, workspace().settingsDir);
  schema = loadProfileSchema(workspace());
  // the ref existence check needs the referenced file to exist
  appendAuditLine(path.join(workspace().dataDir, 'logs', 'heartbeat.jsonl'), { event: 'test' });
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
});

const addOp = (over: Partial<Extract<ProfileOp, { op: 'ADD' }>> = {}): ProfileOp => ({
  op: 'ADD',
  partition: 'interest',
  topic: 'games',
  subTopic: 'preference',
  content: '喜欢肉鸽卡牌',
  confidence: 0.6,
  why: '多次观察到',
  evidence: [ev('chat')],
  ...over,
});

test('ADD happy path: within schema, evidence resolves, confidence capped by kind', () => {
  const doc = emptyProfile();
  const r = applyOpsToDoc(guard, workspace().dataDir, doc, [addOp()], schema, policy, NOW);
  assert.equal(r.applied.length, 1);
  const entry = doc.partitions.interest!.entries[0]!;
  assert.equal(entry.temporal, 'stable'); // preference sub_topic: stable only
  assert.equal(entry.confidence, 0.6);
  assert.match(entry.id, /^p/);
});

test('ADD rejected: unlisted topic/sub_topic (charter boundary)', () => {
  const doc = emptyProfile();
  const r = applyOpsToDoc(guard, workspace().dataDir, doc, [
    addOp({ topic: 'crypto' }),
    addOp({ subTopic: 'unknown_sub' }),
  ], schema, policy, NOW);
  assert.equal(r.applied.length, 0);
  assert.equal(r.rejected.length, 2);
});

test('ADD rejected: no evidence or dangling ref (axiom 1)', () => {
  const doc = emptyProfile();
  const r1 = applyOpsToDoc(guard, workspace().dataDir, doc, [addOp({ evidence: [] })], schema, policy, NOW);
  assert.match(r1.rejected[0]!.reason, /evidence/);
  const r2 = applyOpsToDoc(guard, workspace().dataDir, doc, [
    addOp({ evidence: [{ kind: 'chat', at: new Date(NOW).toISOString(), ref: 'logs/no-such-file.jsonl#x' }] }),
  ], schema, policy, NOW);
  assert.match(r2.rejected[0]!.reason, /does not resolve/);
});

test('ADD confidence capped: screen source cannot exceed 0.4', () => {
  const doc = emptyProfile();
  const r = applyOpsToDoc(guard, workspace().dataDir, doc, [
    addOp({ confidence: 0.9, evidence: [ev('screen')] }),
  ], schema, policy, NOW);
  assert.equal(doc.partitions.interest!.entries[0]!.confidence, 0.4);
  void r;
});

test('ADD to psy is gated by policy.profile.psyEnabled', () => {
  const doc = emptyProfile();
  const r = applyOpsToDoc(guard, workspace().dataDir, doc, [
    addOp({ partition: 'psy', topic: 'baseline', subTopic: 'stress' }),
  ], schema, policy, NOW);
  assert.match(r.rejected[0]!.reason, /psy/);
});

test('UPDATE confidence upgrade needs a second confirming observation', () => {
  const doc = emptyProfile();
  applyOpsToDoc(guard, workspace().dataDir, doc, [addOp()], schema, policy, NOW);
  const id = doc.partitions.interest!.entries[0]!.id;
  const r1 = applyOpsToDoc(guard, workspace().dataDir, doc, [
    { op: 'UPDATE', id, changes: { confidence: 0.8 }, why: '想升级' },
  ], schema, policy, NOW + 1);
  assert.match(r1.rejected[0]!.reason, /second confirming/);
  const r2 = applyOpsToDoc(guard, workspace().dataDir, doc, [
    { op: 'UPDATE', id, changes: { confidence: 0.6 }, why: '维持' },
  ], schema, policy, NOW + 1);
  assert.equal(r2.applied.length, 1);
});

test('INVALIDATE ownership: volatile is code-owned; stable needs newer contradicting evidence', () => {
  const doc = emptyProfile();
  applyOpsToDoc(guard, workspace().dataDir, doc, [
    addOp({ subTopic: 'current', temporal: 'volatile' }),
    addOp(),
  ], schema, policy, NOW);
  const volatileId = doc.partitions.interest!.entries[0]!.id;
  const stableId = doc.partitions.interest!.entries[1]!.id;
  const r1 = applyOpsToDoc(guard, workspace().dataDir, doc, [
    { op: 'INVALIDATE', id: volatileId, why: '过期了吧' },
  ], schema, policy, NOW + 1);
  assert.match(r1.rejected[0]!.reason, /code-owned/);
  const r2 = applyOpsToDoc(guard, workspace().dataDir, doc, [
    { op: 'INVALIDATE', id: stableId, why: '不玩了' },
  ], schema, policy, NOW + 1);
  assert.match(r2.rejected[0]!.reason, /newer contradicting/);
  const r3 = applyOpsToDoc(guard, workspace().dataDir, doc, [
    { op: 'INVALIDATE', id: stableId, why: '他明确说不喜欢了', evidence: [ev('chat', NOW + 2 * DAY)] },
  ], schema, policy, NOW + 2 * DAY);
  assert.equal(r3.applied.length, 1);
  assert.ok(doc.partitions.interest!.entries[1]!.validTo);
});

test('deterministic aging: volatile expires at 14d, stable marked low-activity at 180d', () => {
  const doc = emptyProfile();
  applyOpsToDoc(guard, workspace().dataDir, doc, [
    addOp({ subTopic: 'current', temporal: 'volatile' }),
    addOp(),
  ], schema, policy, NOW);
  const aged = runDeterministicAging(doc, policy, NOW + 15 * DAY);
  assert.equal(aged.volatileExpired, 1);
  assert.equal(aged.lowActivityMarked, 0);
  const aged2 = runDeterministicAging(doc, policy, NOW + 181 * DAY);
  assert.equal(aged2.lowActivityMarked, 1);
  assert.equal(doc.partitions.interest!.entries[1]!.lowActivity, true);
  // stable was NOT time-killed even after 181 days
  assert.equal(doc.partitions.interest!.entries[1]!.validTo, null);
});

test('partition cap rejects ADD when full', () => {
  const tiny: Policy = { ...policy, profile: { ...policy.profile, partitionCap: 1 } };
  const doc = emptyProfile();
  const r1 = applyOpsToDoc(guard, workspace().dataDir, doc, [addOp()], schema, tiny, NOW);
  assert.equal(r1.applied.length, 1);
  const r2 = applyOpsToDoc(guard, workspace().dataDir, doc, [
    addOp({ topic: 'anime_manga', content: '另一条' }),
  ], schema, tiny, NOW + 1);
  assert.match(r2.rejected[0]!.reason, /at cap/);
});

test('journal + verify: consistent after apply+persist; detect tampering', () => {
  const doc = emptyProfile();
  const r = applyOpsToDoc(guard, workspace().dataDir, doc, [addOp()], schema, policy, NOW);
  persistWithJournal(guard, workspace().dataDir, doc, { runId: 't1', applied: r.applied, rejected: r.rejected });
  const v1 = verifyProfile(guard, workspace().dataDir);
  assert.equal(v1.ok, true);
  // tamper with the materialized view
  const disk = loadProfile(guard, profileFilePath(workspace().dataDir));
  disk.partitions.interest!.entries[0]!.content = '被篡改的内容';
  fs.writeFileSync(profileFilePath(workspace().dataDir), JSON.stringify(disk), 'utf8');
  const v2 = verifyProfile(guard, workspace().dataDir);
  assert.equal(v2.ok, false);
  assert.ok(v2.firstDivergence);
});

test('rebuild: journal is authoritative; --check diffs without writing', () => {
  const doc = emptyProfile();
  const r = applyOpsToDoc(guard, workspace().dataDir, doc, [addOp()], schema, policy, NOW);
  persistWithJournal(guard, workspace().dataDir, doc, { runId: 't2', applied: r.applied, rejected: r.rejected });
  // tamper
  const disk = loadProfile(guard, profileFilePath(workspace().dataDir));
  disk.partitions.interest!.entries = [];
  fs.writeFileSync(profileFilePath(workspace().dataDir), JSON.stringify(disk), 'utf8');
  const check = rebuildProfile(guard, workspace().dataDir, { check: true });
  assert.equal(check.ok, false);
  assert.equal(check.wrote, false);
  const real = rebuildProfile(guard, workspace().dataDir, {});
  assert.equal(real.ok, true);
  assert.equal(real.wrote, true);
  const restored = loadProfile(guard, profileFilePath(workspace().dataDir));
  assert.equal(restored.partitions.interest!.entries[0]!.content, '喜欢肉鸽卡牌');
  // the rebuilt view carries the journal-assigned id (UPDATE/INVALIDATE stay resolvable)
  assert.match(restored.partitions.interest!.entries[0]!.id, /^p/);
  void journalFilePath;
});

test('rebuild tolerates a torn journal tail and reports it explicitly', () => {
  const doc = emptyProfile();
  const r = applyOpsToDoc(guard, workspace().dataDir, doc, [addOp()], schema, policy, NOW);
  persistWithJournal(guard, workspace().dataDir, doc, { runId: 't3', applied: r.applied, rejected: r.rejected });
  const journalPath = journalFilePath(workspace().dataDir);
  fs.writeFileSync(journalPath, fs.readFileSync(journalPath, 'utf8') + '{"ts":"2026-09-06T12:0', 'utf8');
  const report = rebuildProfile(guard, workspace().dataDir, {});
  assert.equal(report.ok, true);
  assert.equal(report.truncatedTail > 0, true);
  assert.ok(fs.readFileSync(path.join(workspace().dataDir, 'logs', 'rebuild-report.txt'), 'utf8').includes('truncated'));
});
