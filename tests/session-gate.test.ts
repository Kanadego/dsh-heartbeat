// 2.3.0 P0-4: the session gate — four verdict categories plus the binding
// policy around them.
//
//   1. archived  — disk truth (workspace.json), removed on first sight
//   2. subagent  — header / delegationDepth / descriptor, removed on first sight
//   3. broken    — unreadable log or tail turn/end reason == null; removed only
//                  after 3 consecutive strikes, cleared by one good read
//   4. delivery  — gate passes AND bindings.deliver === true (notepad/statusbar)
//
// The 60s cache is exercised too: a verdict is reused inside the window and
// re-evaluated after it, and observe+deliver in one beat must not double-count
// a broken strike or duplicate the audit line.

import { sandboxDir } from './_sandbox.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import {
  BROKEN_STRIKES_TO_REMOVE,
  SESSION_GATE_TTL_MS,
  checkDeliverySession,
  gateBoundSession,
  isSubagentSession,
  resetSessionGateCache,
  sessionLooksBroken,
} from '../src/core/session-gate.js';
import type { HostSession } from '../src/core/orchestrator.js';
import { loadBindings, removeBinding } from '../src/core/bindings.js';

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;
let settingsDir = '';
let auditFile = '';

beforeEach(() => {
  sandbox = sandboxDir('hb-gate-');
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  guard = createPathGuard(workspace().dataDir);
  settingsDir = workspace().settingsDir;
  auditFile = path.join(workspace().logsDir, 'heartbeat.jsonl');
  resetSessionGateCache();
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
});

type Event = { type: string; data?: unknown };
type HeaderSession = HostSession & { header?: { origin?: string; delegationDepth?: number } };

function sessionOf(id: string, events: Event[] = [{ type: 'user/message' }]): HeaderSession {
  return { id, snapshotEvents: () => events };
}

function throwingSession(id: string): HostSession {
  return {
    id,
    snapshotEvents: () => {
      throw new Error('session log unreadable');
    },
  };
}

function writeRegistry(archived: string[]): string {
  const file = path.join(sandbox, `workspace-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ global: { archivedSessionIds: archived } }), 'utf8');
  return file;
}

function writeBindings(bindings: { sessionId: string; deliver: boolean; observe?: boolean }[]): void {
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, 'bindings.json'),
    JSON.stringify({
      bindings: bindings.map((b) => ({
        sessionId: b.sessionId,
        deliver: b.deliver,
        observe: b.observe ?? false,
        addedAt: '2026-11-17T00:00:00.000Z',
      })),
    }),
    'utf8',
  );
}

function auditEvents(): { event: string; sessionId?: string; reason?: string }[] {
  if (!fs.existsSync(auditFile)) return [];
  return fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as { event: string; sessionId?: string; reason?: string });
}

function gate(id: string, session: HostSession | undefined, now: number, registryFile?: string) {
  return gateBoundSession({
    sessionId: id,
    session,
    guard,
    settingsDir,
    auditFile,
    registryFile,
    now,
  });
}

// ── 1. archived ─────────────────────────────────────────────────────────

test('archived: registry hit denies, removes the binding on first sight, audits once per TTL', () => {
  const id = 'session-archived-1';
  const registry = writeRegistry([id]);
  const session = sessionOf(id);

  const first = gate(id, session, 1_000_000, registry);
  assert.equal(first.allowed, false);
  assert.equal(first.reason, 'archived');
  assert.equal(first.removeBinding, true);

  const skipped = auditEvents().filter((e) => e.event === 'session_skipped');
  assert.deepEqual(skipped.map((e) => [e.sessionId, e.reason]), [[id, 'archived']]);

  // Same beat (observe then deliver): cache hit, no duplicate audit line.
  const second = gate(id, session, 1_000_000 + 5_000, registry);
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'archived');
  assert.equal(second.cached, true);
  assert.equal(auditEvents().filter((e) => e.event === 'session_skipped').length, 1);
});

test('archived: an unprefixed registry entry still catches the session- prefixed id', () => {
  const registry = writeRegistry(['plain-id']);
  const verdict = gate('session-plain-id', sessionOf('session-plain-id'), 2_000_000, registry);
  assert.equal(verdict.reason, 'archived');
});

test('archived: the deliver pre-pass (no live session) still denies and removes the binding', () => {
  // H-archived main path: deliverPackage judges the registry BEFORE any resume.
  // If the archived check ever moves behind `if (!session) return null`, the
  // target would be brought live (and the turn blocked) instead of removed.
  const id = 'session-archived-prepass';
  const registry = writeRegistry([id]);
  writeBindings([{ sessionId: id, deliver: true }]);

  const verdict = gate(id, undefined, 2_500_000, registry);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'archived');
  assert.equal(verdict.removeBinding, true);
  assert.equal(verdict.cached, false);

  // The orchestrator's removal step for any `removeBinding` verdict.
  assert.equal(removeBinding(guard, settingsDir, id), true);
  assert.equal(loadBindings(guard, settingsDir).bindings.some((b) => b.sessionId === id), false);
});

// ── 2. subagent ─────────────────────────────────────────────────────────

test('subagent: header.origin, delegationDepth and the descriptor marker all deny', () => {
  const origin = sessionOf('session-sub-origin');
  origin.header = { origin: 'subagent' };
  const depth = sessionOf('session-sub-depth');
  depth.header = { delegationDepth: 2 };
  const descriptor = sessionOf('session-sub-descriptor', [
    { type: 'subagent/descriptor' },
    { type: 'user/message' },
  ]);

  for (const [id, session] of [
    ['session-sub-origin', origin],
    ['session-sub-depth', depth],
    ['session-sub-descriptor', descriptor],
  ] as const) {
    assert.equal(isSubagentSession(session), true);
    const verdict = gate(id, session, 3_000_000);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, 'subagent');
    assert.equal(verdict.removeBinding, true, 'subagent is a deterministic fact: first sight removes');
  }

  const plain = sessionOf('session-plain');
  plain.header = { origin: 'user', delegationDepth: 0 };
  assert.equal(isSubagentSession(plain), false);
  assert.equal(gate('session-plain', plain, 3_000_000).allowed, true);
});

// ── 3. broken (strikes) ─────────────────────────────────────────────────

test('broken: unreadable log needs 3 consecutive strikes; a good read clears the counter', () => {
  const id = 'session-broken-1';
  let mode: 'throw' | 'ok' = 'throw';
  const session: HostSession = {
    id,
    snapshotEvents: () => {
      if (mode === 'throw') throw new Error('snapshot exploded');
      return [{ type: 'user/message' }];
    },
  };

  const t0 = 4_000_000;
  const step = SESSION_GATE_TTL_MS + 1;
  const strikes: boolean[] = [];
  for (let i = 0; i < BROKEN_STRIKES_TO_REMOVE; i += 1) {
    const verdict = gate(id, session, t0 + i * step);
    assert.equal(verdict.reason, 'broken');
    strikes.push(verdict.removeBinding);
  }
  assert.deepEqual(strikes, [false, false, true], 'removal only after 3 consecutive bad beats');
  assert.equal(
    auditEvents().filter((e) => e.event === 'session_skipped' && e.reason === 'broken').length,
    BROKEN_STRIKES_TO_REMOVE,
  );

  const state = JSON.parse(fs.readFileSync(path.join(settingsDir, 'state.json'), 'utf8')) as {
    brokenStrikes?: Record<string, { count: number }>;
  };
  assert.equal(state.brokenStrikes?.[id]?.count, BROKEN_STRIKES_TO_REMOVE);

  // One good read clears the strikes (the binding survives a transient failure).
  mode = 'ok';
  const good = gate(id, session, t0 + 4 * step);
  assert.equal(good.allowed, true);
  assert.equal(good.brokenStrikes, 0);
  const afterState = JSON.parse(fs.readFileSync(path.join(settingsDir, 'state.json'), 'utf8')) as {
    brokenStrikes?: Record<string, { count: number }>;
  };
  assert.equal(afterState.brokenStrikes?.[id], undefined);
});

test('broken: tail turn/end with reason == null is poison; a healthy tail is not', () => {
  const poisoned = sessionOf('session-poison', [
    { type: 'turn/start' },
    { type: 'turn/end', data: { reason: { kind: 'end_turn' } } },
    { type: 'turn/start' },
    { type: 'turn/end', data: { reason: null } },
  ]);
  assert.equal(sessionLooksBroken(poisoned), true);
  assert.equal(gate('session-poison', poisoned, 5_000_000).reason, 'broken');

  const healthy = sessionOf('session-healthy', [
    { type: 'turn/end', data: { reason: null } }, // old history: not the tail
    { type: 'turn/start' },
    { type: 'turn/end', data: { reason: { kind: 'end_turn' } } },
  ]);
  assert.equal(sessionLooksBroken(healthy), false);
  assert.equal(gate('session-healthy', healthy, 5_000_000).allowed, true);
});

test('broken: missing data / missing reason key is not evidence of a broken session', () => {
  // Bare turn/end rows are ordinary (repo fixtures contain them); fail-closed
  // here silently deletes healthy bindings three beats later.
  assert.equal(sessionLooksBroken(sessionOf('session-bare', [{ type: 'turn/end' }])), false);
  assert.equal(sessionLooksBroken(sessionOf('session-nodata', [{ type: 'turn/end', data: {} }])), false);
  // Primitive data must not make `'reason' in d` throw: bad shapes are not evidence.
  assert.equal(sessionLooksBroken(sessionOf('session-raw-string', [{ type: 'turn/end', data: 'boom' }])), false);
  assert.equal(sessionLooksBroken(sessionOf('session-raw-number', [{ type: 'turn/end', data: 42 }])), false);
  // session-gate.ts 的 sessionLooksBroken 守卫 (p04 收尾审查)：`typeof null ===
  // 'object'`，turn/end 的 data 为 null 时走的是守卫里 `d === null` 这半边——
  // 与上面的缺 key / 原始值形状同理，都是「reason 缺失」而非损坏证据。
  assert.equal(sessionLooksBroken(sessionOf('session-null-data', [{ type: 'turn/end', data: null }])), false);
});

test('broken: a passive success clears the streak, and the following cache hit must not resurrect it', () => {
  const id = 'session-recovering';
  writeBindings([{ sessionId: id, deliver: true }]);
  let mode: 'throw' | 'ok' = 'throw';
  const session: HostSession = {
    id,
    snapshotEvents: () => {
      if (mode === 'throw') throw new Error('snapshot exploded');
      return [{ type: 'user/message' }];
    },
  };
  const t0 = 8_000_000;
  const step = SESSION_GATE_TTL_MS + 1;
  assert.equal(gate(id, session, t0).brokenStrikes, 1);
  assert.equal(gate(id, session, t0 + step).brokenStrikes, 2);

  // The user writes: the passive statusbar/notepad probe re-evaluates after the
  // TTL, succeeds, and must also clear the persisted count.
  mode = 'ok';
  const passive = checkDeliverySession({ sessionId: id, session, guard, settingsDir, now: t0 + 2 * step });
  assert.deepEqual(passive, { allowed: true, reason: null });
  const stateFile = path.join(settingsDir, 'state.json');
  const afterPassive = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as {
    brokenStrikes?: Record<string, { count: number }>;
  };
  assert.equal(afterPassive.brokenStrikes?.[id], undefined, 'passive success clears state.json');

  // Next beat rides the cached allowed verdict — it must not revive count=2.
  const cachedBeat = gate(id, session, t0 + 2 * step + 5_000);
  assert.equal(cachedBeat.allowed, true);
  assert.equal(cachedBeat.cached, true);

  // One bad beat after that is strike 1 (not 3): the binding survives.
  mode = 'throw';
  const nextBad = gate(id, session, t0 + 3 * step + 5_000);
  assert.equal(nextBad.reason, 'broken');
  assert.equal(nextBad.brokenStrikes, 1);
  assert.equal(nextBad.removeBinding, false);
});

test('broken: a cached allowed verdict clears an already-persisted strike entry', () => {
  const id = 'session-cache-clear';
  const t0 = 9_000_000;
  assert.equal(gate(id, sessionOf(id), t0).allowed, true); // fills the cache
  const stateFile = path.join(settingsDir, 'state.json');
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ brokenStrikes: { [id]: { count: 2, lastAt: '2026-11-17T00:00:00.000Z' } } }),
    'utf8',
  );
  const cached = gate(id, sessionOf(id), t0 + 5_000);
  assert.equal(cached.cached, true);
  assert.equal(cached.allowed, true);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as {
    brokenStrikes?: Record<string, { count: number }>;
  };
  assert.equal(state.brokenStrikes?.[id], undefined);
});

test('broken: an archived-only pre-pass is not a health probe and leaves strikes alone', () => {
  const id = 'session-prepass';
  const t0 = 10_000_000;
  const stateFile = path.join(settingsDir, 'state.json');
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ brokenStrikes: { [id]: { count: 2, lastAt: '2026-11-17T00:00:00.000Z' } } }),
    'utf8',
  );
  const prepass = gate(id, undefined, t0);
  assert.equal(prepass.allowed, true);
  assert.equal(prepass.cached, false);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as {
    brokenStrikes?: Record<string, { count: number }>;
  };
  assert.equal(state.brokenStrikes?.[id]?.count, 2, 'the delivery pre-pass cannot judge health');
});

// ── 4. delivery-session predicate (notepad / statusbar) ─────────────────

test('delivery: allowed only when the gate passes AND the binding says deliver === true', () => {
  writeBindings([
    { sessionId: 'session-deliver', deliver: true },
    { sessionId: 'session-observe-only', deliver: false, observe: true },
  ]);
  const plain = sessionOf('session-deliver');
  const observeOnly = sessionOf('session-observe-only');

  assert.deepEqual(
    checkDeliverySession({ sessionId: 'session-deliver', session: plain, guard, settingsDir, now: 6_000_000 }),
    { allowed: true, reason: null },
  );
  assert.deepEqual(
    checkDeliverySession({ sessionId: 'session-observe-only', session: observeOnly, guard, settingsDir, now: 6_000_000 }),
    { allowed: false, reason: 'not-deliver' },
  );
  assert.deepEqual(
    checkDeliverySession({ sessionId: 'session-unbound', session: sessionOf('session-unbound'), guard, settingsDir, now: 6_000_000 }),
    { allowed: false, reason: 'not-bound' },
  );
});

test('delivery: gate reasons rank above bindings, and the 60s cache expires', () => {
  const id = 'session-archived-delivery';
  writeBindings([{ sessionId: id, deliver: true }]);
  const registry = writeRegistry([]);
  const session = sessionOf(id);
  const t0 = 7_000_000;

  assert.equal(
    checkDeliverySession({ sessionId: id, session, guard, settingsDir, registryFile: registry, now: t0 }).allowed,
    true,
  );

  // The session is archived mid-window: the cache still says "allowed"…
  fs.writeFileSync(registry, JSON.stringify({ global: { archivedSessionIds: [id] } }), 'utf8');
  assert.equal(
    checkDeliverySession({ sessionId: id, session, guard, settingsDir, registryFile: registry, now: t0 + SESSION_GATE_TTL_MS - 1 }).allowed,
    true,
  );
  // …and the next beat after the TTL sees the truth.
  assert.deepEqual(
    checkDeliverySession({ sessionId: id, session, guard, settingsDir, registryFile: registry, now: t0 + SESSION_GATE_TTL_MS }).reason,
    'archived',
  );
});
