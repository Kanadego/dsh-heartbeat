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
import { runPowerShell } from '../src/core/ps.js';
import {
  agentTurn,
  BeatAbortedError,
  throwIfAborted,
  withTimeout,
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
