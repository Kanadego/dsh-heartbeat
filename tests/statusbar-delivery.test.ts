// P0-5: the statusbar only rides delivery sessions.
//
// Track A (system-prompt section) renders for a deliver-bound session and drops
// out for everyone else; the skip is audited once per switch (repeated renders
// must not spam), and deny → allow → deny audits twice. Track B (pre-step
// status line) follows the same predicate, leaving the time line itself intact.

import { sandboxDir } from './_sandbox.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import { addBinding } from '../src/core/bindings.js';
import { checkDeliverySession, resetSessionGateCache } from '../src/core/session-gate.js';
import type { HostSession } from '../src/core/orchestrator.js';
import {
  registerStatusbarSection,
  resetCapabilityCache,
  resetPins,
  resetStatusbarSkipMemo,
  resetTrackMemo,
} from '../src/statusbar/track.js';
import { registerTimeInjection } from '../src/statusbar/time-inject.js';
import { StatusReader, writeStatus } from '../src/statusbar/store.js';

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;
let settingsDir = '';
let auditFile = '';

beforeEach(() => {
  sandbox = sandboxDir('hb-statusbar-delivery-');
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  guard = createPathGuard(workspace().dataDir);
  settingsDir = workspace().settingsDir;
  auditFile = path.join(workspace().logsDir, 'heartbeat.jsonl');
  resetSessionGateCache();
  resetCapabilityCache();
  resetPins();
  resetTrackMemo();
  resetStatusbarSkipMemo();
});

after(() => {
  resetWorkspaceForTest();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

type Event = { type: string; data?: unknown };

function capableSession(id: string, events: Event[] = []): HostSession {
  return {
    id,
    snapshotEvents: () => [
      ...events,
      { type: 'request/context', data: { systemPromptUpdate: 'in-history' } },
    ],
  };
}

function verdictFor(session: HostSession) {
  return checkDeliverySession({
    sessionId: session.id,
    session,
    guard,
    settingsDir,
  });
}

interface SectionDef {
  name: string;
  order: number;
  text: (context: unknown) => string;
}

function mountTrackA(): SectionDef {
  let def: SectionDef | null = null;
  const ctx = {
    inject(_services: string[], cb: (scoped: unknown) => void) {
      cb({
        systemPrompt: {
          section(definition: SectionDef) {
            def = definition;
            return {};
          },
        },
        effect(fn: () => unknown) {
          fn();
          return undefined;
        },
        logger: { warn: () => {}, info: () => {}, error: () => {} },
      });
    },
  };
  registerStatusbarSection(ctx, guard, workspace(), {
    enabled: () => true,
    reader: new StatusReader(),
    isDeliverSession: verdictFor,
  });
  assert.ok(def, 'section was registered');
  return def as unknown as SectionDef;
}

function textFor(def: SectionDef, session: HostSession): string {
  return def.text({ agent: { session } });
}

function skips(sessionId?: string): { reason?: string }[] {
  if (!fs.existsSync(auditFile)) return [];
  return fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as { event: string; sessionId?: string; reason?: string })
    .filter((e) => e.event === 'statusbar_skipped' && (sessionId === undefined || e.sessionId === sessionId));
}

// ── Track A ─────────────────────────────────────────────────────────────

test('Track A: a delivery session renders its status line as before', () => {
  addBinding(guard, settingsDir, 's-deliver', { deliver: true });
  writeStatus(guard, workspace(), { at: 'x', scene: 'just-spoke' });
  const def = mountTrackA();
  assert.match(textFor(def, capableSession('s-deliver')), /心跳此刻：刚去和你说过话。$/);
  assert.equal(skips().length, 0);
});

test('Track A: a non-delivery session renders empty; repeated renders audit one skip', () => {
  const session = capableSession('s-observer'); // no binding at all
  const def = mountTrackA();
  assert.equal(textFor(def, session), '');
  assert.equal(textFor(def, session), '');
  assert.equal(textFor(def, session), '');
  assert.deepEqual(skips('s-observer').map((s) => s.reason), ['not-bound']);
});

test('Track A: deny → allow → deny audits twice', () => {
  addBinding(guard, settingsDir, 's-flip', { deliver: false });
  writeStatus(guard, workspace(), { at: 'x', scene: 'present' });
  const session = capableSession('s-flip');
  const def = mountTrackA();

  assert.equal(textFor(def, session), '');
  addBinding(guard, settingsDir, 's-flip', { deliver: true });
  assert.match(textFor(def, session), /心跳此刻：在场待着。$/);
  addBinding(guard, settingsDir, 's-flip', { deliver: false });
  assert.equal(textFor(def, session), '');

  assert.equal(skips('s-flip').length, 2);
});

// ── Track B (pre-step trailing line) ────────────────────────────────────

interface PreStep {
  agent: { session: HostSession };
  step: number;
}

type Listener = (payload: PreStep, next: () => Promise<unknown>) => Promise<unknown>;

function userOpenedTurn(): Event[] {
  return [
    { type: 'turn/end', data: { reason: { kind: 'end_turn' } } },
    { type: 'agent/inbox/spliced', data: { inserted: [{ source: { kind: 'user' } }] } },
  ];
}

async function injectOnce(session: HostSession): Promise<string> {
  let listener: Listener | null = null;
  registerTimeInjection(
    {
      on(_event: string, fn: Listener) {
        listener = fn;
        return () => {};
      },
    },
    guard,
    workspace().dataDir,
    {
      getTimeInjectMin: () => 1,
      paths: workspace(),
      logger: { info: () => {}, warn: () => {} },
      onError: (e) => { throw e; },
      getStatusLine: () => '心跳此刻：在场待着。',
      pinTrack: () => 'pre-step',
      isDeliverSession: verdictFor,
    },
  );
  assert.ok(listener, 'pre-step listener was registered');
  const out = await (listener as Listener)(
    { agent: { session }, step: 1 },
    async () => ({ kind: 'enter', messages: [] }),
  ) as { kind: string; messages: { content?: { text?: string }[] }[] };
  assert.equal(out.kind, 'enter');
  assert.equal(out.messages.length, 1);
  return out.messages[0]?.content?.[0]?.text ?? '';
}

test('Track B: delivery session gets the trailing status line; non-delivery keeps only the time', async () => {
  addBinding(guard, settingsDir, 's-b-deliver', { deliver: true });

  const delivered = await injectOnce(capableSession('s-b-deliver', userOpenedTurn()));
  assert.match(delivered, /当前本地时间：/);
  assert.match(delivered, /心跳此刻：在场待着。$/);

  const withheld = await injectOnce(capableSession('s-b-observer', userOpenedTurn()));
  assert.match(withheld, /当前本地时间：/);
  assert.doesNotMatch(withheld, /心跳此刻/);
  assert.deepEqual(skips('s-b-observer').map((s) => s.reason), ['not-bound']);
});
