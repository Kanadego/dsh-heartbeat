// v2.1.0 interval jitter: the recurring schedule redraws each delay as
// interval × (1 + u), u uniform in [-p, +p], floored at one minute.
//
// The scheduling loop itself is a cordis lifecycle (startOrchestrator) — the
// unit cover here is the pure layer: the percentage clamp, the delay draw's
// bounds/distribution, the schema validation, and the factory policy values.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertPolicy, deepMerge } from '../src/config/schema.js';
import {
  DEFAULT_INTERVAL_JITTER_PCT,
  clampJitterPct,
  jitteredIntervalMs,
} from '../src/core/orchestrator.js';

const MIN = 60_000;

// ── clampJitterPct ───────────────────────────────────────────────────────

test('clampJitterPct: missing or invalid values fall back to the factory default', () => {
  assert.equal(DEFAULT_INTERVAL_JITTER_PCT, 20);
  assert.equal(clampJitterPct(undefined), 20);
  assert.equal(clampJitterPct(null), 20);
  assert.equal(clampJitterPct('20'), 20);
  assert.equal(clampJitterPct(Number.NaN), 20);
  assert.equal(clampJitterPct(Number.POSITIVE_INFINITY), 20);
});

test('clampJitterPct: clamps into [0, 50], keeps valid values as-is', () => {
  assert.equal(clampJitterPct(-5), 0);
  assert.equal(clampJitterPct(0), 0);
  assert.equal(clampJitterPct(20), 20);
  assert.equal(clampJitterPct(33.5), 33.5);
  assert.equal(clampJitterPct(50), 50);
  assert.equal(clampJitterPct(80), 50);
});

// ── jitteredIntervalMs ───────────────────────────────────────────────────

test('jitteredIntervalMs: p=0 means the exact interval, whatever the draw', () => {
  for (const rand of [0, 0.25, 0.5, 0.9, 1]) {
    assert.equal(jitteredIntervalMs(60 * MIN, 0, () => rand), 60 * MIN);
  }
});

test('jitteredIntervalMs: the draw spans [-p, +p] around the base', () => {
  const base = 60 * MIN;
  assert.equal(jitteredIntervalMs(base, 20, () => 0), Math.round(base * 0.8));
  assert.equal(jitteredIntervalMs(base, 20, () => 0.5), base);
  assert.equal(jitteredIntervalMs(base, 20, () => 1), Math.round(base * 1.2));
  assert.equal(jitteredIntervalMs(base, 50, () => 0), Math.round(base * 0.5));
  assert.equal(jitteredIntervalMs(base, 50, () => 1), Math.round(base * 1.5));
});

test('jitteredIntervalMs: never below one minute, even at a full negative draw', () => {
  // 1.2 min at -50% draws 0.6 min -> the floor must catch it.
  assert.equal(jitteredIntervalMs(1.2 * MIN, 50, () => 0), MIN);
  assert.equal(jitteredIntervalMs(1 * MIN, 50, () => 0), MIN);
});

test('jitteredIntervalMs: random draws stay within bounds on both sides', () => {
  const base = 60 * MIN;
  let below = 0;
  let above = 0;
  for (let i = 0; i < 500; i += 1) {
    const ms = jitteredIntervalMs(base, 20);
    assert.ok(ms >= Math.round(base * 0.8) && ms <= Math.round(base * 1.2), `out of bounds: ${ms}`);
    assert.ok(Number.isInteger(ms));
    if (ms < base) below += 1;
    if (ms > base) above += 1;
  }
  // A uniform ±20% draw nearly always lands off the base on both sides.
  assert.ok(below > 100 && above > 100, `distribution looks wrong: below=${below} above=${above}`);
});

// ── schema validation ────────────────────────────────────────────────────

const FACTORY = {
  heartbeat: { intervalMin: 60, idleMode: false, archiveRotatedHome: true, intervalJitterPct: 20 },
  gate: { maxDailySend: 10, cooldownMinutes: 30, quietHours: { start: '01:00', end: '08:00' } },
  browse: { windows: [{ start: '11:00', end: '15:00' }], minIntervalHours: 4, maxSeedsPerVisit: 4 },
  seeds: { maxActive: 30, ttlDays: { news: 3, fandom: 14, scene: 60, promise: 90 }, coldBenchDays: 21, archiveCap: 50, retireAfterUsed: 2, scoreWeights: { freshness: 0.4, unused: 0.3, confidence: 0.3 } },
  profile: { consolidation: { minIntervalHours: 12, inboxBacklog: 30 }, partitionCap: 50, maxOpsPerRun: 10, confidenceCap: { chat: 0.6, screen: 0.4, browse: 0.4 }, volatileDays: 14, stableLowActivityDays: 180, psyEnabled: false },
  observe: { maxChars: 80, perBeat: 10 },
  weekly: { enabled: true, keepReports: 3 },
  retention: { envPulseHours: 48, decisionLogDays: 30 },
};

test('assertPolicy accepts the range [0, 50] and an absent field', () => {
  assert.doesNotThrow(() => assertPolicy(structuredClone(FACTORY)));
  assert.doesNotThrow(() => assertPolicy(deepMerge(FACTORY, { heartbeat: { intervalJitterPct: 0 } })));
  assert.doesNotThrow(() => assertPolicy(deepMerge(FACTORY, { heartbeat: { intervalJitterPct: 50 } })));
  const absent = structuredClone(FACTORY);
  delete (absent.heartbeat as { intervalJitterPct?: number }).intervalJitterPct;
  assert.doesNotThrow(() => assertPolicy(absent)); // pre-existing policy layers
});

test('assertPolicy rejects out-of-range or malformed intervalJitterPct', () => {
  assert.throws(() => assertPolicy(deepMerge(FACTORY, { heartbeat: { intervalJitterPct: 51 } })), /intervalJitterPct/);
  assert.throws(() => assertPolicy(deepMerge(FACTORY, { heartbeat: { intervalJitterPct: -1 } })), /intervalJitterPct/);
  assert.throws(() => assertPolicy(deepMerge(FACTORY, { heartbeat: { intervalJitterPct: '20' } })), /intervalJitterPct/);
});

// ── factory policy file carries the new values ───────────────────────────

test('config/policy.json: intervalJitterPct=20, browse.maxSeedsPerVisit=4, and it validates', () => {
  const raw = JSON.parse(
    fs.readFileSync(fileURLToPath(new URL('../config/policy.json', import.meta.url)), 'utf8'),
  ) as { heartbeat: { intervalJitterPct: number }; browse: { maxSeedsPerVisit: number } };
  assert.equal(raw.heartbeat.intervalJitterPct, 20);
  assert.equal(raw.browse.maxSeedsPerVisit, 4);
  assert.doesNotThrow(() => assertPolicy(raw));
});
