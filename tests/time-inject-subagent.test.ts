// isSubagentSession verdict order: header.origin → header.delegationDepth →
// bounded event-stream scan for subagent/descriptor. Pure tests, no sandbox.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HostSession } from '../src/core/orchestrator.js';
import { isSubagentSession } from '../src/statusbar/time-inject.js';

type WithHeader = HostSession & {
  header?: { origin?: string; delegationDepth?: number; [k: string]: unknown };
};

const sessionWithHeader = (header: WithHeader['header'], events: { type: string }[] = []): HostSession =>
  ({ id: 'session-test', header, snapshotEvents: () => events }) as HostSession;

const eventSession = (events: { type: string }[]): HostSession =>
  ({ id: 'session-test', snapshotEvents: () => events }) as HostSession;

test('header.origin === "subagent" → true', () => {
  const session = sessionWithHeader(
    { origin: 'subagent', parentSession: 'session-d0a27c45', delegationDepth: 0 },
    [{ type: 'user/message' }],
  );
  assert.equal(isSubagentSession(session), true);
});

test('header.delegationDepth > 0 → true (even without origin)', () => {
  const session = sessionWithHeader(
    { delegationDepth: 2 },
    [{ type: 'user/message' }],
  );
  assert.equal(isSubagentSession(session), true);
});

test('plain session: header present but no origin/depth, no descriptor → false', () => {
  const session = sessionWithHeader(
    { isSeeded: false, agentPreset: 'ptc' },
    [{ type: 'user/message' }, { type: 'turn/end' }],
  );
  assert.equal(isSubagentSession(session), false);
});

test('header missing (old harness) but event stream logs subagent/descriptor → true', () => {
  const session = eventSession([
    { type: 'subagent/descriptor' },
    { type: 'user/message' },
  ]);
  assert.equal(isSubagentSession(session), true);
});

test('descriptor scan is bounded to the first 8 events', () => {
  const late = [{ type: 'user/message' }, ...Array.from({ length: 8 }, () => ({ type: 'step/end' })),
    { type: 'subagent/descriptor' }];
  assert.equal(isSubagentSession(eventSession(late)), false);
});

test('delegationDepth 0 (top level) does not count as subagent', () => {
  const session = sessionWithHeader({ origin: 'user', delegationDepth: 0 }, []);
  assert.equal(isSubagentSession(session), false);
});

test('undefined session → false (defensive, never throws)', () => {
  assert.equal(isSubagentSession(undefined), false);
});

test('session without any event accessor → false', () => {
  assert.equal(isSubagentSession({ id: 'session-bare' } as HostSession), false);
});
