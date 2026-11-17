// ⑤A (HB-08): cancellation cover. The review's finding was that the watchdog
// only cleared flags — the timed-out phase kept running (and could still write
// state) beside the next beat. These tests pin the three mechanisms that fixed
// it: the phase guard, the ceiling that aborts the beat controller, and the
// subprocess / host turn that actually stops.

import { sandboxDir } from './_sandbox.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import { resetRuntimeForTest, setRuntime } from '../src/core/runtime.js';
import { savePool, seedsFilePath } from '../src/seeds/pool.js';
import { runPowerShell } from '../src/core/ps.js';
import type { Policy } from '../src/config/schema.js';
import {
  agentTurn,
  beat,
  resetHomeAgent,
  startOrchestrator,
  BeatAbortedError,
  throwIfAborted,
  withTimeout,
  type AgentCancelCause,
  type OrchestratorDeps,
} from '../src/core/orchestrator.js';

let sandbox = '';

beforeEach(() => {
  sandbox = sandboxDir('hb-cancel-');
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
});

after(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

const isAbort = (stage: string) => (e: unknown): boolean => {
  assert.ok(e instanceof BeatAbortedError, `expected BeatAbortedError, got ${String(e)}`);
  assert.equal((e as BeatAbortedError).stage, stage);
  return true;
};

test('throwIfAborted: a live beat passes, an aborted one throws with stage and reason', () => {
  const ctl = new AbortController();
  throwIfAborted(ctl.signal, 'collect'); // no throw while the beat is alive
  throwIfAborted(undefined, 'collect'); // no signal (tests, one-shot calls)
  ctl.abort('watchdog: still running after 45 min');
  assert.throws(() => throwIfAborted(ctl.signal, 'collect'), (e: unknown) => {
    assert.ok(e instanceof BeatAbortedError);
    assert.equal((e as BeatAbortedError).stage, 'collect');
    assert.equal((e as BeatAbortedError).why, 'watchdog: still running after 45 min');
    assert.match((e as Error).message, /collect: beat aborted/);
    return true;
  });
});

test('withTimeout: a ceiling hit aborts the beat controller, not just the race', async () => {
  const ctl = new AbortController();
  await assert.rejects(
    withTimeout(new Promise<string>(() => {}), 20, 'wander', { cancelBeat: ctl }),
    isAbort('wander'),
  );
  assert.equal(ctl.signal.aborted, true);
  assert.match(String(ctl.signal.reason), /timeout after/);
});

test('withTimeout: the beat signal cancels the wait and hands control to onAbort', async () => {
  const ctl = new AbortController();
  let cancelled = false;
  const p = withTimeout(new Promise<string>(() => {}), 60_000, 'expression', {
    signal: ctl.signal,
    onAbort: () => { cancelled = true; },
  });
  ctl.abort('orchestrator disposed');
  await assert.rejects(p, isAbort('expression'));
  assert.equal(cancelled, true);
});

test('withTimeout: an already-aborted beat never lets the work start', async () => {
  const ctl = new AbortController();
  ctl.abort('beat already over');
  let onAbortRan = false;
  await assert.rejects(
    withTimeout(new Promise<string>(() => {}), 60_000, 'maintenance', {
      signal: ctl.signal,
      onAbort: () => { onAbortRan = true; },
    }),
    isAbort('maintenance'),
  );
  assert.equal(onAbortRan, true);
});

test('withTimeout: a settled promise resolves normally and clears its timer', async () => {
  assert.equal(await withTimeout(Promise.resolve('ok'), 60_000, 'collect'), 'ok');
});

test('runPowerShell: an already-aborted signal never spawns anything', async () => {
  const ctl = new AbortController();
  ctl.abort('beat over');
  const r = await runPowerShell(['-Command', 'Start-Sleep -Seconds 30'], 60_000, ctl.signal);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, 'aborted');
});

test('runPowerShell: aborting mid-run kills the child and settles as cancelled', async () => {
  const ctl = new AbortController();
  const p = runPowerShell(['-Command', 'Start-Sleep -Seconds 30'], 60_000, ctl.signal);
  setTimeout(() => ctl.abort('watchdog'), 200);
  const r = await p;
  assert.equal(r.status, 1);
  assert.equal(r.stderr, 'aborted');
});

test('agentTurn: a cancelled beat cancels the host turn instead of waiting it out', async () => {
  const ctl = new AbortController();
  let cancelled = false;
  let followed = 0;
  const agent = {
    id: 'a1',
    session: { id: 's1', events: [], snapshotEvents: () => [] },
    followup: () => { followed += 1; },
    whenIdle: () => new Promise<void>(() => {}),
    cancel: () => { cancelled = true; },
  };
  const deps = { paths: workspace() } as unknown as OrchestratorDeps;
  const p = agentTurn(deps, agent as never, 'hello', 'expression', 60_000, ctl.signal);
  ctl.abort('orchestrator disposed');
  await assert.rejects(p, isAbort('expression'));
  assert.equal(followed, 1, 'the prompt was handed to the host before cancellation');
  assert.equal(cancelled, true);
});

// ── issue #11: every cancel carries an AgentCancelCause ──────────────────
//
// A host that writes `turn/end.reason` from the cancel argument used to get
// null here, and any history projection reading `reason.kind` then threw —
// one bad record closed the whole session. These cases pin the three call
// sites (agentTurn abort, orphan decision turn, plugin dispose) and the
// backward-compatible path for a host whose cancel takes no argument.

/** Full policy stub: the beat tests below run the real phase chain, so every
 *  section the phases read must exist. Quiet hours are an empty window. */
const CANCEL_POLICY: Policy = {
  heartbeat: { intervalMin: 20, idleMode: false, archiveRotatedHome: false },
  gate: { maxDailySend: 8, cooldownMinutes: 30, quietHours: { start: '00:00', end: '00:00' } },
  browse: { windows: [], minIntervalHours: 4, maxSeedsPerVisit: 5 },
  seeds: {
    maxActive: 50,
    ttlDays: { news: 7, fandom: 7, scene: 3, promise: 30 },
    coldBenchDays: 7,
    archiveCap: 100,
    retireAfterUsed: 3,
    scoreWeights: { freshness: 0.5, unused: 0.3, confidence: 0.2 },
  },
  profile: {
    consolidation: { minIntervalHours: 24, inboxBacklog: 20 },
    partitionCap: 80,
    maxOpsPerRun: 6,
    confidenceCap: { chat: 1, screen: 1, browse: 1 },
    volatileDays: 7,
    stableLowActivityDays: 14,
    psyEnabled: false,
  },
  observe: { maxChars: 200, perBeat: 10 },
  weekly: { enabled: false, keepReports: 4 },
  retention: { envPulseHours: 24, decisionLogDays: 30 },
};

interface BeatHarness {
  deps: OrchestratorDeps;
  dispose: () => void;
}

/** Stub deps for one full beat: a live-looking agent handle, one active topic
 *  seed (so expressionPhases reaches its decision turn) and a missing assets
 *  directory, which makes every PowerShell probe degrade instantly instead of
 *  touching the real screen. */
function makeBeatHarness(agent: Record<string, unknown>): BeatHarness {
  const paths = { ...workspace(), assetsDir: path.join(sandbox, 'missing-assets') };
  const guard = createPathGuard(paths.dataDir);
  // No interests: wander/refill stay out of the beat, so the only model turn
  // is the expression decision turn these cases care about.
  fs.writeFileSync(path.join(paths.settingsDir, 'interests.json'), '{"interests":[],"_schedule":{}}', 'utf8');
  const now = Date.now();
  savePool(guard, seedsFilePath(paths.dataDir), {
    seq: 1,
    seeds: [{
      id: 's1',
      text: '一条用于取消测试的素材',
      topic: '取消测试',
      tag: 'news',
      source: 'browse',
      category: 'topic',
      confidence: 0.5,
      protected: false,
      used: 0,
      bornAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 6 * 86_400_000).toISOString(),
      lastUsedAt: null,
      lastEvidenceAt: new Date(now).toISOString(),
      status: 'active',
    }],
  });
  let dispose: () => void = () => {};
  const ctx = {
    agents: {
      create: async () => ({ agent }),
      resume: async () => ({ agent }),
      roots: () => [],
      get: () => undefined,
    },
    logger: { info() {}, warn() {}, error() {} },
    effect: (fn: () => unknown) => { dispose = fn() as () => void; return () => {}; },
  };
  const deps = { ctx, paths, guard, policy: CANCEL_POLICY } as unknown as OrchestratorDeps;
  setRuntime({
    paths,
    guard,
    policy: CANCEL_POLICY,
    flags: {
      statusbarEnabled: () => false,
      timeInjectMin: () => 0,
      idleMode: () => false,
      tokenSaver: () => false,
      // v2.2.1-native.1: '' = follow vision.json (auto); the harness has no
      // attachments service, so native fails fast and the beat proceeds.
      visionEngine: () => '',
    },
  });
  return { deps, dispose: () => dispose() };
}

function stubAgent(cancel: (cause?: AgentCancelCause) => void, opts: { followup?: () => void; whenIdle?: () => Promise<void> } = {}) {
  return {
    id: 'hb-stub',
    session: { id: 'session-hb-stub', events: [], snapshotEvents: () => [] },
    options: { model: 'test-model' },
    followup: opts.followup ?? (() => {}),
    whenIdle: opts.whenIdle ?? (async () => {}),
    cancel,
  } as unknown as Record<string, unknown>;
}

test('agentTurn: the timeout cancel carries a hook cause (issue #11)', async () => {
  const ctl = new AbortController();
  const causes: (AgentCancelCause | undefined)[] = [];
  const agent = stubAgent((cause) => { causes.push(cause); }, { whenIdle: () => new Promise<void>(() => {}) });
  const deps = { paths: workspace() } as unknown as OrchestratorDeps;
  const p = agentTurn(deps, agent as never, 'hello', 'expression', 60_000, ctl.signal);
  ctl.abort('watchdog');
  await assert.rejects(p, isAbort('expression'));
  assert.deepEqual(causes, [{ kind: 'hook', reason: 'heartbeat-timeout' }]);
});

test('agentTurn: an abort for orchestrator disposed carries the disposed cause (issue #11)', async () => {
  // A dispose can land while agentTurn is waiting and before the beat has wired
  // its cancel handle: the abort path itself must surface `disposed`, or the
  // host records a hook cause and the goal round driver never disarms.
  const ctl = new AbortController();
  const causes: (AgentCancelCause | undefined)[] = [];
  const agent = stubAgent((cause) => { causes.push(cause); }, { whenIdle: () => new Promise<void>(() => {}) });
  const deps = { paths: workspace() } as unknown as OrchestratorDeps;
  const p = agentTurn(deps, agent as never, 'hello', 'expression', 60_000, ctl.signal);
  ctl.abort('orchestrator disposed');
  await assert.rejects(p, isAbort('expression'));
  assert.deepEqual(causes, [{ kind: 'disposed' }]);
});

test('agentTurn: a host cancel declared without parameters still works (issue #11 compat)', async () => {
  const ctl = new AbortController();
  let cancelled = 0;
  const agent = {
    id: 'a-legacy',
    session: { id: 's-legacy', events: [], snapshotEvents: () => [] },
    followup: () => {},
    whenIdle: () => new Promise<void>(() => {}),
    // Explicitly zero-arity: the extra cause argument must be ignored, not thrown over.
    cancel: (): void => { cancelled += 1; },
  };
  const deps = { paths: workspace() } as unknown as OrchestratorDeps;
  const p = agentTurn(deps, agent as never, 'hello', 'expression', 60_000, ctl.signal);
  ctl.abort('watchdog');
  await assert.rejects(p, isAbort('expression'));
  assert.equal(cancelled, 1);
});

test('beat: a failed decision turn cancels the orphan host turn with a hook cause (issue #11)', async () => {
  resetHomeAgent();
  const causes: (AgentCancelCause | undefined)[] = [];
  const agent = stubAgent((cause) => { causes.push(cause); }, {
    followup: () => { throw new Error('host refused the decision prompt'); },
  });
  const h = makeBeatHarness(agent);
  try {
    await beat(h.deps, 'interval');
  } finally {
    resetRuntimeForTest();
  }
  assert.deepEqual(causes, [{ kind: 'hook', reason: 'heartbeat-orphan-turn' }]);
});

test('dispose: an in-flight beat cancels the host turn with a disposed cause (issue #11)', async () => {
  resetHomeAgent();
  const causes: (AgentCancelCause | undefined)[] = [];
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const agent = stubAgent((cause) => { causes.push(cause); }, {
    followup: () => { markStarted(); },
    whenIdle: () => new Promise<void>(() => {}),
  });
  const h = makeBeatHarness(agent);
  startOrchestrator(h.deps);
  const running = beat(h.deps, 'interval');
  try {
    await started;
    h.dispose();
    await running;
  } finally {
    resetRuntimeForTest();
  }
  // The host takes only the FIRST cancel cause: the dispose must win over the
  // abort's onAbort cancel, or the goal round driver never sees `disposed`.
  // Cancels of the already stopped turn after it are redundant (host-ignored):
  // only their shape is pinned, so optimisations that stop re-cancelling do not
  // turn this case red for the wrong reason.
  assert.deepEqual(causes[0], { kind: 'disposed' });
  for (const cause of causes) {
    assert.ok(cause, 'every host cancel must carry a cause');
    assert.ok(
      ['user', 'parent', 'hook', 'disposed'].includes(cause.kind),
      `unexpected cause kind: ${cause.kind}`,
    );
    if (cause.kind === 'hook') assert.ok(cause.reason.trim() !== '', 'hook cancels must name a reason');
  }
});
