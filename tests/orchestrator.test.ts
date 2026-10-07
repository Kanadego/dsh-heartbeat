// H-85: regression cover for the orchestrator's pure logic. These are the
// pieces the review found untested — the module had no test file at all, only
// indirect cover through home-rotation.test.ts.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import { saveEncryptedText } from '../src/vault/vault.js';
import { appendAuditLine } from '../src/core/audit-log.js';
import {
  agentLooksAlive,
  applyHeartbeatInterval,
  buildEngineRoomAllowList,
  gateFilePath,
  HOME_ROTATE_EVENT_COUNT,
  homeSessionId,
  isContextOverflowError,
  loadCursors,
  parseJsonBlock,
  pickSpokenLine,
  resetHomeSession,
  sessionEventCount,
  sessionEvents,
  shouldArchiveRotatedHome,
  shouldRotateHome,
  spokeTextSince,
  type HostSession,
} from '../src/core/orchestrator.js';

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-orch-'));
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  guard = createPathGuard(workspace().dataDir);
});

after(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

// ── sessionEvents / sessionEventCount (H-05 baseline) ────────────────────

test('sessionEvents: prefers snapshotEvents and forwards the seq filter', () => {
  const seen: (number | undefined)[] = [];
  const session: HostSession = {
    id: 's1',
    snapshotEvents: (fromSeq?: number) => { seen.push(fromSeq); return [{ type: 'user/message' }]; },
  };
  assert.equal(sessionEvents(session).length, 1);
  assert.equal(sessionEvents(session, 7).length, 1);
  assert.deepEqual(seen, [undefined, 7]);
});

test('sessionEvents: a throwing snapshot accessor falls back to the legacy events array', () => {
  const session: HostSession = {
    id: 's1',
    snapshotEvents: () => { throw new Error('no session'); },
    events: [{ type: 'a' }, { type: 'b' }, { type: 'c' }],
  };
  assert.equal(sessionEvents(session).length, 3);
  assert.deepEqual(sessionEvents(session, 1), [{ type: 'b' }, { type: 'c' }]);
});

test('sessionEvents: a missing session is an empty log, never a throw', () => {
  assert.deepEqual(sessionEvents(undefined), []);
  assert.deepEqual(sessionEvents({ id: 's1' }), []);
});

test('sessionEventCount: uses seq when present, else counts the events', () => {
  assert.equal(sessionEventCount(undefined), 0);
  assert.equal(sessionEventCount({ id: 's1', seq: 42 }), 42);
  assert.equal(sessionEventCount({ id: 's1', events: [{ type: 'a' }] }), 1);
});

// ── home rotation (pure decisions) ───────────────────────────────────────

test('isContextOverflowError: matches the provider wordings, not arbitrary errors', () => {
  assert.equal(isContextOverflowError('Error: CONTEXT_WINDOW_EXCEEDED'), true);
  assert.equal(isContextOverflowError('request failed: context overflow'), true);
  assert.equal(isContextOverflowError('CONTEXT OVERFLOW'), true);
  assert.equal(isContextOverflowError('ECONNRESET'), false);
});

test('shouldRotateHome: rotates at the threshold, honours an override', () => {
  assert.equal(shouldRotateHome({ eventCount: HOME_ROTATE_EVENT_COUNT - 1 }), false);
  assert.equal(shouldRotateHome({ eventCount: HOME_ROTATE_EVENT_COUNT }), true);
  assert.equal(shouldRotateHome({ eventCount: 10, threshold: 10 }), true);
  assert.equal(shouldRotateHome({ eventCount: 9, threshold: 10 }), false);
});

test('shouldArchiveRotatedHome: needs a real, different, still-enabled id', () => {
  assert.equal(shouldArchiveRotatedHome({ old: 'a', realId: 'b', enabled: true }), true);
  assert.equal(shouldArchiveRotatedHome({ old: 'a', realId: 'a', enabled: true }), false);
  assert.equal(shouldArchiveRotatedHome({ old: null, realId: 'b', enabled: true }), false);
  assert.equal(shouldArchiveRotatedHome({ old: undefined, realId: 'b', enabled: true }), false);
  assert.equal(shouldArchiveRotatedHome({ old: 'a', realId: 'b', enabled: false }), false);
});

// ── engine-room allow list ───────────────────────────────────────────────

test('buildEngineRoomAllowList: web_search first, extras only when present, deduped', () => {
  assert.deepEqual(buildEngineRoomAllowList([]), ['web_search']);
  assert.deepEqual(buildEngineRoomAllowList(['web_search']), ['web_search']);
  // extra tools are added only if the global layer actually carries them
  assert.deepEqual(buildEngineRoomAllowList(['web_search', 'compress']), ['web_search', 'compress']);
  assert.deepEqual(buildEngineRoomAllowList(['web_search', 'nope']), ['web_search']);
  // config extras: trimmed, blanks dropped, duplicates ignored, order stable
  assert.deepEqual(
    buildEngineRoomAllowList(['web_search', 'compress', 'modlens'], [' modlens ', '', 'compress', '  ']),
    ['web_search', 'compress', 'modlens'],
  );
});

// ── H-02: the cached agent handle must not outlive its session ───────────

test('agentLooksAlive: rejects a disposed handle even when it still has a session', () => {
  assert.equal(agentLooksAlive(null), false);
  assert.equal(agentLooksAlive(undefined), false);
  assert.equal(agentLooksAlive({ disposed: true, session: { id: 's1' } } as never), false);
  assert.equal(agentLooksAlive({ session: { id: 's1' } } as never), true);
  // a live handle always carries its session
  assert.equal(agentLooksAlive({} as never), false);
});

// ── H-09 / H-45: the shared home-session helpers ─────────────────────────

test('homeSessionId: null without a gate file, the stored id once written', () => {
  const paths = workspace();
  assert.equal(homeSessionId(guard, paths), null);
  saveEncryptedText(guard, gateFilePath(paths), JSON.stringify({ sessionId: 'session-home' }, null, 2));
  assert.equal(homeSessionId(guard, paths), 'session-home');
});

test('homeSessionId: a corrupt gate file degrades to null instead of throwing', () => {
  const paths = workspace();
  saveEncryptedText(guard, gateFilePath(paths), 'not json at all');
  assert.equal(homeSessionId(guard, paths), null);
});

test('resetHomeSession: refuses a foreign id, releases the home and audits it', () => {
  const paths = workspace();
  saveEncryptedText(guard, gateFilePath(paths), JSON.stringify({ sessionId: 'session-home' }));

  assert.equal(resetHomeSession(guard, paths, 'session-other'), false);
  assert.equal(fs.existsSync(gateFilePath(paths)), true, 'a foreign id must not touch the gate file');
  assert.equal(homeSessionId(guard, paths), 'session-home');

  assert.equal(resetHomeSession(guard, paths, 'session-home'), true);
  assert.equal(fs.existsSync(gateFilePath(paths)), false, 'the gate file is removed');
  assert.equal(homeSessionId(guard, paths), null);

  const lines = fs.readFileSync(path.join(paths.logsDir, 'heartbeat.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const reset = lines.filter((l) => l.event === 'home_reset');
  assert.equal(reset.length, 1);
  assert.equal(reset[0]!.oldSessionId, 'session-home');
});

// ── applyHeartbeatInterval (policy write happens before reschedule) ──────

test('applyHeartbeatInterval: clamps, writes the policy and audits the change', () => {
  const paths = workspace();
  const deps = {
    policy: { heartbeat: { intervalMin: 20 } },
    paths,
  } as unknown as Parameters<typeof applyHeartbeatInterval>[0];

  applyHeartbeatInterval(deps, 45);
  assert.equal(deps.policy.heartbeat.intervalMin, 45);

  // same value again -> no second audit line
  applyHeartbeatInterval(deps, 45);

  applyHeartbeatInterval(deps, 0); // clamped up to 1
  assert.equal(deps.policy.heartbeat.intervalMin, 1);
  applyHeartbeatInterval(deps, 99999); // clamped down to 1440
  assert.equal(deps.policy.heartbeat.intervalMin, 1440);

  const lines = fs.readFileSync(path.join(paths.logsDir, 'heartbeat.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const changes = lines.filter((l) => l.event === 'interval_changed').map((l) => l.intervalMin);
  assert.deepEqual(changes, [45, 1, 1440]);
});

// ── H-05: observation cursors ────────────────────────────────────────────

test('loadCursors: version 2 files round-trip, junk values are dropped', () => {
  const file = path.join(workspace().dataDir, 'cursors.json');
  fs.writeFileSync(file, JSON.stringify({ version: 2, sessions: { a: 5, b: 0, c: -1, d: 'x', e: 1.7 } }), 'utf8');
  const loaded = loadCursors(file);
  assert.equal(loaded.discardedLegacy, false);
  assert.deepEqual(loaded.sessions, { a: 5, b: 0, e: 1 });
});

test('loadCursors: a pre-H-05 file is discarded wholesale, a missing one is not "legacy"', () => {
  const file = path.join(workspace().dataDir, 'cursors.json');
  fs.writeFileSync(file, JSON.stringify({ s1: 12 }), 'utf8'); // index-based, no version key
  const legacy = loadCursors(file);
  assert.equal(legacy.discardedLegacy, true);
  assert.deepEqual(legacy.sessions, {});

  const missing = loadCursors(path.join(workspace().dataDir, 'nope.json'));
  assert.equal(missing.discardedLegacy, false, 'no file yet is not the same as a legacy file');
  assert.deepEqual(missing.sessions, {});
});

// ── H-67: reading what she actually said ─────────────────────────────────

test('parseJsonBlock: plain JSON, fenced JSON, and prose around it', () => {
  assert.deepEqual(parseJsonBlock('{"speak":true}'), { speak: true });
  assert.deepEqual(parseJsonBlock('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonBlock('好的，这是结果：\n{"a":1}\n以上。'), { a: 1 });
});

test('parseJsonBlock: two adjacent objects yield the first one', () => {
  assert.deepEqual(parseJsonBlock('{"first":1}{"second":2}'), { first: 1 });
});

test('parseJsonBlock: distinguishes "no object" from "unparseable object"', () => {
  assert.throws(() => parseJsonBlock('没有任何 JSON'), /no JSON object in model output/);
  assert.throws(() => parseJsonBlock('{"broken": '), /unparseable JSON object in model output/);
});

test('pickSpokenLine: drops thinking blocks and tool-call tags, prefers the last Chinese line', () => {
  const raw = [
    'thinking out loud',
    '<tool_calls>',
    '第一句中文',
    '她最后说的那一句',
  ].join('\n');
  const picked = pickSpokenLine(raw);
  assert.equal(picked.spokeText, true);
  assert.equal(picked.text, '她最后说的那一句');
});

test('pickSpokenLine: a Chinese-free turn reports spokeText false', () => {
  const picked = pickSpokenLine('no chinese here\njust english');
  assert.equal(picked.spokeText, false);
  assert.equal(picked.text, 'just english');
});

test('pickSpokenLine: an empty turn yields an empty result', () => {
  assert.deepEqual(pickSpokenLine('   '), { text: '', spokeText: false });
});

test('spokeTextSince: finds Chinese assistant text past the cursor, skips the rest', () => {
  const session: HostSession = {
    id: 's1',
    events: [
      { type: 'assistant/message', data: { content: [{ type: 'text', text: '旧的一句' }] } }, // before the cursor
      { type: 'user/message', data: { content: [{ type: 'text', text: '用户说中文' }] } },   // not assistant
      { type: 'assistant/message', data: { content: [{ type: 'text', text: 'only english' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '新的一句心声' }] } } },
    ],
  };
  assert.equal(spokeTextSince(session, 1), '新的一句心声');
  assert.equal(spokeTextSince(session, 4), null, 'nothing past the cursor');
  assert.equal(spokeTextSince(undefined, 0), null);
});

test('spokeTextSince: reads the `message.content` shape too (older host)', () => {
  const session: HostSession = {
    id: 's1',
    events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '兼容旧形状' }] } } }],
  };
  assert.equal(spokeTextSince(session, 0), '兼容旧形状');
});
