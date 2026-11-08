// turnOriginIsUserSplice tests (M7b §17.6, tightened 2026-11-08): the open
// turn counts as user-initiated only when the splice that OPENED it carries a
// real user message (source.kind === 'user'). Heartbeat / delivery splices and
// malformed payloads never do, and splices from the PREVIOUS turn don't leak in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnOriginIsUserSplice } from '../src/statusbar/time-inject.js';
import type { HostSession } from '../src/core/orchestrator.js';

/** Structural twin of the harness event (`HostEvent` isn't exported). */
interface TestEvent {
  type: string;
  data?: unknown;
}

const msg = (kind: string): { source: { kind: string } } => ({ source: { kind } });

const spliced = (inserted: unknown): TestEvent => ({
  type: 'agent/inbox/spliced',
  data: { inserted },
});

const mk = (events: TestEvent[]): HostSession => ({
  id: 'session-x',
  snapshotEvents: () => events,
});

test('turnOriginIsUserSplice: user splice opens the turn → true', () => {
  assert.equal(turnOriginIsUserSplice(mk([
    { type: 'turn/end' },
    spliced([msg('user')]),
  ])), true);
  // another plugin wrote events AFTER the splice — turn origin unaffected
  assert.equal(turnOriginIsUserSplice(mk([
    { type: 'turn/end' },
    spliced([msg('user')]),
    { type: 'team/message/delivered' },
  ])), true);
});

test('turnOriginIsUserSplice: heartbeat splice → false', () => {
  assert.equal(turnOriginIsUserSplice(mk([
    { type: 'turn/end' },
    spliced([msg('heartbeat')]),
  ])), false);
});

test('turnOriginIsUserSplice: empty inserted array → false', () => {
  assert.equal(turnOriginIsUserSplice(mk([
    { type: 'turn/end' },
    spliced([]),
  ])), false);
});

test('turnOriginIsUserSplice: one splice, heartbeat first + user later → true', () => {
  assert.equal(turnOriginIsUserSplice(mk([
    { type: 'turn/end' },
    spliced([msg('heartbeat'), msg('user')]),
  ])), true);
});

test('turnOriginIsUserSplice: malformed payloads → false, never throws', () => {
  // no data at all
  assert.equal(turnOriginIsUserSplice(mk([
    { type: 'turn/end' },
    { type: 'agent/inbox/spliced' },
  ])), false);
  // inserted is not an array
  assert.equal(turnOriginIsUserSplice(mk([
    { type: 'turn/end' },
    spliced('garbage'),
  ])), false);
  // entries without source
  assert.equal(turnOriginIsUserSplice(mk([
    { type: 'turn/end' },
    spliced([{}, { text: 'no source here' }]),
  ])), false);
  // null-ish entries must not throw either
  assert.equal(turnOriginIsUserSplice(mk([
    { type: 'turn/end' },
    spliced([null, undefined]),
  ])), false);
});

test('turnOriginIsUserSplice: previous turn never leaks into the current one', () => {
  // user splice opened the PREVIOUS turn; this turn only has a heartbeat splice
  assert.equal(turnOriginIsUserSplice(mk([
    spliced([msg('user')]),
    { type: 'turn/end' },
    spliced([msg('heartbeat')]),
  ])), false);
  // the FIRST splice inside the turn defines the origin: a heartbeat splice
  // that opened the turn is not redeemed by a later user splice mid-turn
  assert.equal(turnOriginIsUserSplice(mk([
    { type: 'turn/end' },
    spliced([msg('heartbeat')]),
    spliced([msg('user')]),
  ])), false);
  // only the LAST turn/end bounds the scan window
  assert.equal(turnOriginIsUserSplice(mk([
    spliced([msg('user')]),
    { type: 'turn/end' },
    { type: 'turn/end' },
    spliced([msg('heartbeat')]),
  ])), false);
});

test('turnOriginIsUserSplice: no turn/end at all (first turn) → scan from 0', () => {
  assert.equal(turnOriginIsUserSplice(mk([
    { type: 'session/started' },
    spliced([msg('user')]),
  ])), true);
  assert.equal(turnOriginIsUserSplice(mk([
    { type: 'session/started' },
    spliced([msg('heartbeat')]),
  ])), false);
  // no splice at all → false
  assert.equal(turnOriginIsUserSplice(mk([
    { type: 'turn/end' },
    { type: 'turn/start' },
  ])), false);
});
