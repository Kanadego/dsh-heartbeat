// Topic preference (2026-10-06): delivered/adopted counters, weight bounds +
// smoothing + decay, and the lockdown-proof pickFocus weighting.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard, type PathGuard } from '../src/core/path-guard.js';
import {
  DECAY_HALF_LIFE_DAYS,
  W_MAX,
  W_MIN,
  loadPreference,
  preferenceFilePath,
  preferenceWeight,
  recordDelivery,
  savePreference,
} from '../src/browse/preference.js';
import { pickFocus, STARVATION_DAYS } from '../src/browse/browse.js';

let sandbox = '';
let guard: PathGuard;
let prefFile: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-pref-'));
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  const paths = initWorkspace();
  guard = createPathGuard(paths.dataDir);
  prefFile = preferenceFilePath(paths.dataDir);
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
});

const DAY = 86_400_000;

test('recordDelivery: folds offered+adopted into per-topic counters', () => {
  const now = Date.now();
  recordDelivery(guard, prefFile, { offeredTopics: ['咖啡', '键盘'], adoptedTopics: ['咖啡'], now });
  recordDelivery(guard, prefFile, { offeredTopics: ['咖啡', '键盘'], adoptedTopics: [], now: now + 1 });
  const st = loadPreference(guard, prefFile);
  assert.equal(st.topics['咖啡']!.delivered, 2);
  assert.equal(st.topics['咖啡']!.adopted, 1);
  assert.equal(st.topics['键盘']!.delivered, 2);
  assert.equal(st.topics['键盘']!.adopted, 0);
});

test('preferenceWeight: bounds, cold-start exploration, and rejection drag', () => {
  const now = Date.now();
  // no data -> exactly neutral (rate 1/4 of the neutral 1/4 prior)
  assert.equal(preferenceWeight({ version: 1, topics: {}, updatedAt: 0 }, '新话题', now), 1);

  // always adopted -> clamped at W_MAX
  const hot = { version: 1 as const, topics: { '咖啡': { delivered: 20, adopted: 20, lastDeliveredAt: now, lastAdoptedAt: now } }, updatedAt: now };
  assert.equal(preferenceWeight(hot, '咖啡', now), W_MAX);

  // never adopted after many deliveries -> floor at W_MIN, never 0
  const cold = { version: 1 as const, topics: { '键盘': { delivered: 20, adopted: 0, lastDeliveredAt: now, lastAdoptedAt: 0 } }, updatedAt: now };
  assert.equal(preferenceWeight(cold, '键盘', now), W_MIN);
  assert.ok(W_MIN > 0);
});

test('preferenceWeight: adoption decays with a 30-day half-life, recent deliveries do not', () => {
  const now = Date.now();
  // everything fresh: 20/20 saturates at W_MAX
  const fresh = { delivered: 20, adopted: 20, lastDeliveredAt: now, lastAdoptedAt: now };
  const freshState = { version: 1 as const, topics: { '咖啡': fresh }, updatedAt: now };
  assert.equal(preferenceWeight(freshState, '咖啡', now), W_MAX);
  // adoptions are a half-life old, deliveries keep coming: adopted decays to 10
  // while delivered stays 20 -> rate (10+1)/(20+4) ≈ 0.46 -> weight < W_MAX
  const staleAdoption = { delivered: 20, adopted: 20, lastDeliveredAt: now, lastAdoptedAt: now - DECAY_HALF_LIFE_DAYS * DAY };
  const staleState = { version: 1 as const, topics: { '咖啡': staleAdoption }, updatedAt: now };
  const w = preferenceWeight(staleState, '咖啡', now);
  assert.ok(w < W_MAX, 'stale adoptions no longer saturate the weight');
  assert.ok(w > W_MIN);
});

test('v1.9.0: loadPreference drops garbled entries and clamps adopted to delivered', () => {
  savePreference(guard, prefFile, {
    version: 1,
    updatedAt: Number.NaN as unknown as number,
    topics: {
      '好话题': { delivered: 10, adopted: 99, lastDeliveredAt: 5, lastAdoptedAt: 5 } as never,
      '坏话题': { delivered: 'abc', adopted: 1 } as never,
      '负数': { delivered: -3, adopted: -1 } as never,
      '空条目': null as never,
      '缺字段': {} as never,
    },
  });
  const st = loadPreference(guard, prefFile);
  assert.deepEqual(Object.keys(st.topics).sort(), ['好话题', '负数'].sort());
  assert.equal(st.topics['好话题']!.adopted, 10, 'adopted can never exceed delivered');
  assert.equal(st.topics['负数']!.delivered, 0, 'negative counters floor at 0');
  assert.equal(st.topics['负数']!.adopted, 0);
  assert.equal(st.updatedAt, 0, 'a garbled timestamp falls back to 0');
  // a dropped entry can never poison the ordering with NaN
  assert.equal(preferenceWeight(st, '坏话题', Date.now()), 1);
});

test('pickFocus: weighting favors the preferred topic but cooldown still rotates everyone', () => {
  const mk = (focusHistory: Record<string, number>) => ({
    targets: {},
    last_check_at: 0,
    wander: { focusHistory, focusCount: {} as Record<string, number>, last_wander_at: 0 },
  });
  const interests = { interests: ['甲', '乙'], _schedule: { focus_cooldown_days: 3 } };
  const now = 1_000 * DAY;
  // 甲 always adopted (w=W_MAX), 乙 never (w=W_MIN); both last used long ago
  const pref = {
    version: 1 as const,
    topics: {
      '甲': { delivered: 20, adopted: 20, lastDeliveredAt: now, lastAdoptedAt: now },
      '乙': { delivered: 20, adopted: 0, lastDeliveredAt: now, lastAdoptedAt: 0 },
    },
    updatedAt: now,
  };
  const st = mk({ 甲: now - 10 * DAY, 乙: now - 10 * DAY });
  assert.equal(pickFocus(st, interests, now, pref), '甲', 'effective age ages the favorite 4x faster');
  // right after 甲 wanders it cools off -> 乙 is the only non-cooling topic
  st.wander.focusHistory['甲'] = now;
  assert.equal(pickFocus(st, interests, now + 1, pref), '乙', 'cooldown guarantees the cold topic its turn');
});

test('pickFocus: starvation floor overrides weighting after STARVATION_DAYS', () => {
  const mk = (focusHistory: Record<string, number>) => ({
    targets: {},
    last_check_at: 0,
    wander: { focusHistory, focusCount: {} as Record<string, number>, last_wander_at: 0 },
  });
  const interests = { interests: ['甲', '乙'], _schedule: { focus_cooldown_days: 0 } };
  const now = 1_000 * DAY;
  const pref = {
    version: 1 as const,
    topics: {
      '甲': { delivered: 20, adopted: 20, lastDeliveredAt: now, lastAdoptedAt: now },
      '乙': { delivered: 20, adopted: 0, lastDeliveredAt: now, lastAdoptedAt: 0 },
    },
    updatedAt: now,
  };
  // 乙 untouched past the starvation floor despite W_MIN and a fresher real age
  const st = mk({ 甲: now - (STARVATION_DAYS + 5) * DAY + DAY, 乙: now - (STARVATION_DAYS + 5) * DAY });
  assert.equal(pickFocus(st, interests, now, pref), '乙', 'oldest real age wins once starved');
  // no pref state -> exactly the old pure-LRU behavior
  assert.equal(pickFocus(mk({ 甲: 5, 乙: 2 }), interests, 10), '乙');
});
