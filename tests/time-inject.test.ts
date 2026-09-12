// M7b time injection tests (design doc §17.6, D20):
// gate matrix, elapsed rendering, last-message scan, throttle state persistence.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import {
  lastMessageTime,
  loadTimeInjectState,
  renderTimeText,
  saveTimeInjectState,
  shouldInjectTime,
  timeInjectStatePath,
  turnOriginIsInboxSplice,
} from '../src/statusbar/time-inject.js';

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-timeinject-'));
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  guard = createPathGuard(workspace().dataDir);
});

after(() => {
  resetWorkspaceForTest();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const MIN = 60_000;

test('shouldInjectTime: full gate matrix', () => {
  const pass = { step: 1, originIsInboxSplice: true, lastInjectAt: 0, now: 25 * MIN, intervalMs: 25 * MIN };
  assert.equal(shouldInjectTime(pass), true);
  // mid-task step: never
  assert.equal(shouldInjectTime({ ...pass, step: 2 }), false);
  // not an inbox-driven turn
  assert.equal(shouldInjectTime({ ...pass, originIsInboxSplice: false }), false);
  // inside the throttle window
  assert.equal(shouldInjectTime({ ...pass, now: 24 * MIN }), false);
  // exactly at the interval boundary passes
  assert.equal(shouldInjectTime({ ...pass, now: 25 * MIN }), true);
  // interval 0 disables injection entirely
  assert.equal(shouldInjectTime({ ...pass, intervalMs: 0 }), false);
});

test('turnOriginIsInboxSplice: robust against interleaved events (琥珀 review #2)', () => {
  const mk = (types: string[]) => ({
    id: 'session-x',
    snapshotEvents: () => types.map((type, i) => ({ type, time: i })),
  });
  // clean user turn: splice is the last event
  assert.equal(turnOriginIsInboxSplice(mk(['turn/end', 'agent/inbox/spliced'])), true);
  // another plugin wrote an event AFTER the splice — still inbox-driven
  assert.equal(turnOriginIsInboxSplice(mk(['turn/end', 'agent/inbox/spliced', 'team/message/delivered'])), true);
  // previous turn ended, then a new splice → new turn is inbox-driven
  assert.equal(turnOriginIsInboxSplice(mk(['agent/inbox/spliced', 'turn/end', 'agent/inbox/spliced'])), true);
  // turn began without a splice since the last turn end → not inbox-driven
  assert.equal(turnOriginIsInboxSplice(mk(['agent/inbox/spliced', 'turn/end', 'turn/start'])), false);
  // no splice at all
  assert.equal(turnOriginIsInboxSplice(mk(['turn/end', 'turn/start'])), false);
  // first-ever turn with a splice (no turn/end in the log)
  assert.equal(turnOriginIsInboxSplice(mk(['agent/inbox/spliced'])), true);
});

test('renderTimeText: precise time line always present; elapsed only with history', () => {
  const now = new Date('2026-09-13T04:05:00+08:00').getTime();
  const bare = renderTimeText({ now, timeZone: 'Asia/Shanghai' });
  assert.match(bare, /当前本地时间：2026-09-13 04:05/);
  assert.match(bare, /\+08:00|GMT\+8/);
  assert.doesNotMatch(bare, /距本会话上一条消息/);
  const withElapsed = renderTimeText({ now, timeZone: 'Asia/Shanghai', lastMessageTime: now - 95 * MIN });
  assert.match(withElapsed, /距本会话上一条消息已过去 1 小时 35 分钟/);
});

test('renderTimeText: invalid timezone falls back without throwing', () => {
  const text = renderTimeText({ now: Date.now(), timeZone: 'Not/AZone' });
  assert.match(text, /当前本地时间：/);
});

test('lastMessageTime: scans backwards for the last message event', () => {
  const session = {
    id: 'session-x',
    seq: 4,
    snapshotEvents: () => [
      { type: 'session/started', time: 1 },
      { type: 'user/message', time: 100 },
      { type: 'assistant/message', time: 250 },
      { type: 'agent/inbox/spliced', time: 300 },
    ],
  };
  assert.equal(lastMessageTime(session), 250);
});

test('time inject state: persists per session across load/save', () => {
  const state = loadTimeInjectState(guard, workspace().dataDir);
  assert.deepEqual(state, {});
  state['session-a'] = 111;
  state['session-b'] = 222;
  saveTimeInjectState(guard, workspace().dataDir, state);
  const reloaded = loadTimeInjectState(guard, workspace().dataDir);
  assert.equal(reloaded['session-a'], 111);
  assert.equal(reloaded['session-b'], 222);
  assert.equal(fs.existsSync(timeInjectStatePath(workspace().dataDir)), true);
});
