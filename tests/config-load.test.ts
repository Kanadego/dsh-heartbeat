import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPolicy } from '../src/config/load.js';
import { assertPolicy, deepMerge } from '../src/config/schema.js';

let sandbox = '';

const FACTORY = {
  heartbeat: { intervalMin: 20 },
  gate: { maxDailySend: 3, cooldownMinutes: 30, quietHours: { start: '01:00', end: '08:00' } },
  browse: { windows: [{ start: '11:00', end: '15:00' }], minIntervalHours: 4, maxSeedsPerVisit: 2 },
  seeds: { maxActive: 30, ttlDays: { news: 3, fandom: 14, scene: 60, promise: 90 }, coldBenchDays: 21, retireAfterUsed: 2, scoreWeights: { freshness: 0.4, unused: 0.3, confidence: 0.3 } },
  profile: { consolidation: { minIntervalHours: 12, inboxBacklog: 30 }, partitionCap: 50, maxOpsPerRun: 10, confidenceCap: { chat: 0.6, screen: 0.4, browse: 0.4 }, volatileDays: 14, stableLowActivityDays: 180, psyEnabled: false },
  retention: { envPulseHours: 48, decisionLogDays: 30 },
};

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-cfg-'));
  fs.mkdirSync(path.join(sandbox, 'config'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'settings'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'config', 'policy.json'), JSON.stringify(FACTORY), 'utf8');
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const guardStub = { assert: (p: string) => p } as never;

test('factory-only load returns factory values', () => {
  const p = loadPolicy(guardStub, path.join(sandbox, 'config'), path.join(sandbox, 'settings'));
  assert.equal(p.heartbeat.intervalMin, 20);
  assert.equal(p.gate.maxDailySend, 3);
  assert.equal(p.profile.psyEnabled, false);
});

test('user layer deep-merges over factory', () => {
  fs.writeFileSync(path.join(sandbox, 'settings', 'policy.json'), JSON.stringify({
    heartbeat: { intervalMin: 45 },
    gate: { maxDailySend: 5 },
  }), 'utf8');
  const p = loadPolicy(guardStub, path.join(sandbox, 'config'), path.join(sandbox, 'settings'));
  assert.equal(p.heartbeat.intervalMin, 45);
  assert.equal(p.gate.maxDailySend, 5);
  // untouched factory fields survive the merge
  assert.equal(p.gate.cooldownMinutes, 30);
  assert.equal(p.gate.quietHours.start, '01:00');
  assert.equal(p.profile.psyEnabled, false);
});

test('invalid user layer fails closed', () => {
  fs.writeFileSync(path.join(sandbox, 'settings', 'policy.json'), '{not json', 'utf8');
  assert.throws(() => loadPolicy(guardStub, path.join(sandbox, 'config'), path.join(sandbox, 'settings')), /unparseable/);
});

test('policy validation rejects out-of-range heartbeat interval', () => {
  const merged = deepMerge(FACTORY, { heartbeat: { intervalMin: 0 } });
  assert.throws(() => assertPolicy(merged), /intervalMin/);
});

test('policy validation rejects malformed quiet hours', () => {
  const merged = deepMerge(FACTORY, { gate: { quietHours: { start: '25:00', end: '08:00' } } });
  assert.throws(() => assertPolicy(merged), /quietHours/);
});
