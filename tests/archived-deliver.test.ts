// H-archived: deliver targets must skip archived sessions, and a silent
// delivery must report WHY it was silent (blocked gate / empty output /
// non-Chinese), not lump everything into "non-Chinese output discarded".
// Background: 2026-11-04 → 11-09, 21 consecutive deliveries into an archived
// session all ended `blocked` with zero output, each misfiled by the audit as
// a language failure.
import { sandboxDir } from './_sandbox.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadArchivedSessionIds, isArchivedSession, splitDeliverTargets } from '../src/core/archived-sessions.js';
import { classifySilentReason, turnEndKindSince, type HostSession } from '../src/core/orchestrator.js';

function writeRegistry(registry: unknown): string {
  const file = path.join(sandboxDir('hb-arch-'), 'workspace.json');
  fs.writeFileSync(file, JSON.stringify(registry), 'utf8');
  return file;
}

/** Minimal HostSession using the legacy `events` accessor (snapshotEvents is
 *  optional and sessionEvents falls back to the array + fromSeq slice). */
function fakeSession(events: { type: string; data?: unknown }[], seq?: number): HostSession {
  return { id: 'fake-session', ...(seq === undefined ? { events } : { seq, events }) };
}

test('loadArchivedSessionIds + isArchivedSession: mixed prefix forms on disk, both recognized', () => {
  const file = writeRegistry({
    global: { archivedSessionIds: ['session-arch-prefixed', 'arch-unprefixed'] },
  });
  const archived = loadArchivedSessionIds(file);
  assert.equal(archived.size, 2);
  // exact match for either form
  assert.equal(isArchivedSession(archived, 'session-arch-prefixed'), true);
  assert.equal(isArchivedSession(archived, 'arch-unprefixed'), true);
  // unprefixed id caught via its prefixed archive entry (strip `session-`)
  assert.equal(isArchivedSession(archived, 'session-arch-unprefixed'), true);
  // active sessions stay usable
  assert.equal(isArchivedSession(archived, 'session-active'), false);
  assert.equal(isArchivedSession(archived, 'active'), false);
});

test('loadArchivedSessionIds: fail-open on missing / corrupt / non-array registry', () => {
  // missing file
  const missing = loadArchivedSessionIds(path.join(os.tmpdir(), 'hb-arch-absent-workspace.json'));
  assert.equal(missing.size, 0);
  // corrupt JSON
  const corrupt = path.join(sandboxDir('hb-arch-'), 'workspace.json');
  fs.writeFileSync(corrupt, '{not json', 'utf8');
  assert.equal(loadArchivedSessionIds(corrupt).size, 0);
  // valid JSON but the field is not an array
  const oddShape = writeRegistry({ global: { archivedSessionIds: 'session-x' } });
  assert.equal(loadArchivedSessionIds(oddShape).size, 0);
  // field absent entirely
  const emptyShape = writeRegistry({ global: {} });
  assert.equal(loadArchivedSessionIds(emptyShape).size, 0);
  // fail-open end to end: an empty archived set passes every target through
  const targets = [{ sessionId: 'session-a' }, { sessionId: 'session-b' }];
  const { usable, skipped } = splitDeliverTargets(targets, missing);
  assert.equal(usable.length, 2);
  assert.equal(skipped.length, 0);
});

test('splitDeliverTargets: preserves caller order in both groups', () => {
  const archived = new Set(['session-a', 'c']);
  const targets = [
    { sessionId: 'session-a' },
    { sessionId: 'session-b' },
    { sessionId: 'c' },
    { sessionId: 'session-d' },
    { sessionId: 'session-e' },
  ];
  const { usable, skipped } = splitDeliverTargets(targets, archived);
  assert.deepEqual(usable.map((t) => t.sessionId), ['session-b', 'session-d', 'session-e']);
  assert.deepEqual(skipped.map((t) => t.sessionId), ['session-a', 'c']);
});

test('turnEndKindSince: blocked / normal end / no turn-end → null; last turn/end wins; honours fromSeq', () => {
  const blocked = fakeSession([
    { type: 'agent/inbox/spliced' },
    { type: 'turn/start' },
    { type: 'agent/inbox/spliced' },
    { type: 'turn/end', data: { reason: { kind: 'blocked' } } },
  ]);
  assert.equal(turnEndKindSince(blocked, 0), 'blocked');

  const normal = fakeSession([
    { type: 'turn/start' },
    { type: 'assistant/message', data: { content: [{ type: 'text', text: '你好' }] } },
    { type: 'turn/end', data: { reason: { kind: 'end_turn' } } },
  ]);
  assert.equal(turnEndKindSince(normal, 0), 'end_turn');

  // no turn/end in the window → null
  const noEnd = fakeSession([{ type: 'turn/start' }, { type: 'assistant/message' }]);
  assert.equal(turnEndKindSince(noEnd, 0), null);
  // empty session → null
  assert.equal(turnEndKindSince(fakeSession([]), 0), null);
  // several turn/ends: the LAST one's kind is reported
  const many = fakeSession([
    { type: 'turn/end', data: { reason: { kind: 'end_turn' } } },
    { type: 'turn/end', data: { reason: { kind: 'blocked' } } },
  ]);
  assert.equal(turnEndKindSince(many, 0), 'blocked');
  // fromSeq excludes earlier events (this turn only)
  assert.equal(turnEndKindSince(many, 1), 'blocked');
  assert.equal(turnEndKindSince(many, 2), null);
  // turn/end without a reason.kind must not poison the scan
  const bare = fakeSession([
    { type: 'turn/end' },
    { type: 'turn/end', data: { reason: { kind: 'end_turn' } } },
  ]);
  assert.equal(turnEndKindSince(bare, 0), 'end_turn');
});

test('classifySilentReason: three states, blocked outranks the rest', () => {
  // blocked: the gate never opened — regardless of whatever raw text exists
  assert.equal(classifySilentReason('', 'blocked'), 'target turn blocked');
  assert.equal(classifySilentReason('some stray text', 'blocked'), 'target turn blocked');
  // literally empty output, turn ended normally
  assert.equal(classifySilentReason('', null), 'empty model output');
  assert.equal(classifySilentReason('   \n  ', null), 'empty model output');
  // legacy state: text exists but nothing speakable survived the filter
  assert.equal(classifySilentReason('hello world', null), 'non-Chinese output discarded');
});

test('regression: one archived + one active target drops only the archived one', () => {
  const file = writeRegistry({
    global: { archivedSessionIds: ['session-gone'] },
  });
  const archived = loadArchivedSessionIds(file);
  const all = [
    { sessionId: 'session-gone', deliver: true },
    { sessionId: 'session-live', deliver: true },
    { sessionId: 'session-home', deliver: false }, // deliver=false never enters all
  ];
  const deliverable = all.filter((b) => b.deliver);
  const { usable, skipped } = splitDeliverTargets(deliverable, archived);
  // the lane is NOT empty — delivery proceeds to the live target
  assert.deepEqual(usable.map((t) => t.sessionId), ['session-live']);
  assert.deepEqual(skipped.map((t) => t.sessionId), ['session-gone']);
});
