// Unit cover for waitForVisibleTool (2026-11-08): the 0.2.2 tool-addition
// timing gap means preset tools may not be on the agent surface when
// presets.mount() resolves. The wait must be bounded, injectable (no real
// sleeping in tests) and degrading — every case here runs on a fake clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForVisibleTool } from '../src/core/orchestrator.js';

/** Fake clock: `sleep` advances it, so `waitedMs` is deterministic and no
 * real time passes. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
    time: () => t,
  };
}

test('waitForVisibleTool: target present on the first read → ready with waitedMs 0', async () => {
  const c = fakeClock();
  const r = await waitForVisibleTool(() => [{ name: 'web_search' }, { name: 'compress' }], 'web_search', {
    now: c.now,
    sleep: c.sleep,
  });
  assert.equal(r.ready, true);
  assert.equal(r.waitedMs, 0);
  assert.deepEqual(r.sawNames, ['web_search', 'compress']);
});

test('waitForVisibleTool: target appears on the 3rd poll → ready, waitedMs matches the fake clock', async () => {
  const c = fakeClock();
  let calls = 0;
  const r = await waitForVisibleTool(() => {
    calls++;
    return calls >= 3 ? [{ name: 'other' }, { name: 'web_search' }] : [];
  }, 'web_search', { timeoutMs: 2000, pollMs: 50, now: c.now, sleep: c.sleep });
  assert.equal(r.ready, true);
  assert.equal(calls, 3);
  // Two failed polls, each advancing the clock by pollMs.
  assert.equal(r.waitedMs, 100);
  assert.deepEqual(r.sawNames, ['other', 'web_search']);
});

test('waitForVisibleTool: never visible → ready:false, no throw, waited at most timeoutMs', async () => {
  const c = fakeClock();
  const r = await waitForVisibleTool(() => [{ name: 'other' }], 'web_search', {
    timeoutMs: 2000,
    pollMs: 50,
    now: c.now,
    sleep: c.sleep,
  });
  assert.equal(r.ready, false);
  assert.equal(r.waitedMs, 2000);
  assert.deepEqual(r.sawNames, ['other']);
});

test('waitForVisibleTool: getSchemas throws then recovers → swallow, keep polling, ready', async () => {
  const c = fakeClock();
  let calls = 0;
  const r = await waitForVisibleTool(() => {
    calls++;
    if (calls === 1) throw new Error('schema read exploded');
    return [{ name: 'web_search' }];
  }, 'web_search', { timeoutMs: 2000, pollMs: 50, now: c.now, sleep: c.sleep });
  assert.equal(r.ready, true);
  assert.equal(calls, 2);
});
