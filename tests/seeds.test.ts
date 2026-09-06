// Deterministic eviction rules (design doc §4.2) - the core of M2.
// Time is injected so every rule is testable without waiting.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import { loadPolicy } from '../src/config/load.js';
import type { Policy } from '../src/config/schema.js';
import {
  activeSeeds,
  addSeed,
  archivedSeeds,
  evictionScore,
  gcPool,
  loadPool,
  pickEvictionVictim,
  seedsFilePath,
  surfaceSeed,
  archiveSeedById,
} from '../src/seeds/pool.js';

const DAY = 86_400_000;
let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;
let file = '';
let policy: Policy;
let now: number;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-seeds-'));
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  guard = createPathGuard(workspace().dataDir);
  file = seedsFilePath(workspace().dataDir);
  policy = loadPolicy(guard, workspace().configDir, workspace().settingsDir);
  now = Date.parse('2026-09-06T12:00:00.000Z');
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
});

test('add assigns id, tag TTL and default confidence; list shows it active', () => {
  const r = addSeed(guard, file, policy, { text: '他在研究 X 插件', tag: 'scene', source: 'chat' }, now);
  assert.equal(r.kind, 'added');
  assert.equal(r.seed.id, 's1');
  assert.equal(r.seed.confidence, 0.6);
  assert.equal(Date.parse(r.seed.expiresAt) - now, 60 * DAY);
  const db = loadPool(guard, file);
  assert.equal(activeSeeds(db).length, 1);
});

test('rule 2 (expired): news tag dies after 3 days at gc', () => {
  addSeed(guard, file, policy, { text: '某新闻事件', tag: 'news', source: 'chat' }, now);
  const report = gcPool(guard, file, policy, now + 4 * DAY);
  assert.equal(report.expired, 1);
  assert.equal(activeSeeds(loadPool(guard, file)).length, 0);
});

test('rule 1 (consumed): used>=2 without newer evidence retires at surface time', () => {
  const r = addSeed(guard, file, policy, { text: '聊过两次的话题', tag: 'scene' }, now);
  surfaceSeed(guard, file, policy, r.seed.id, now + DAY);
  const second = surfaceSeed(guard, file, policy, r.seed.id, now + 2 * DAY);
  // evidence is NOT newer than last use -> retired immediately on surfacing
  assert.equal(second!.status, 'archived');
  assert.equal(second!.retireReason, 'consumed');
  // gc is the backstop: nothing left to do
  const report = gcPool(guard, file, policy, now + 3 * DAY);
  assert.equal(report.consumed, 0);
  assert.equal(activeSeeds(loadPool(guard, file)).length, 0);
  assert.equal(archivedSeeds(loadPool(guard, file))[0]!.retireReason, 'consumed');
});

test('rule 1 spared when new evidence arrived after the last surfacing', () => {
  const r = addSeed(guard, file, policy, { text: '有后续进展的话题', tag: 'scene' }, now);
  surfaceSeed(guard, file, policy, r.seed.id, now + DAY);
  // new evidence on the same topic refreshes the seed (merge path)
  addSeed(guard, file, policy, { text: '有后续进展的话题：他又提了新细节', topic: r.seed.topic, tag: 'scene' }, now + 2 * DAY);
  const report = gcPool(guard, file, policy, now + 3 * DAY);
  assert.equal(report.consumed, 0);
  assert.equal(activeSeeds(loadPool(guard, file)).length, 1);
});

test('rule 3 (cold bench): unused for 21 days retires at gc', () => {
  addSeed(guard, file, policy, { text: '一直没人提起', tag: 'promise', source: 'chat' }, now);
  const report = gcPool(guard, file, policy, now + 22 * DAY);
  assert.equal(report.coldBench, 1);
  // promise tag TTL is 90d, so this must be cold_bench, not expired
  assert.equal(archivedSeeds(loadPool(guard, file))[0]!.retireReason, 'cold_bench');
});

test('same-topic actives merge: latest brief, used accumulates, evidence time merges', () => {
  const a = addSeed(guard, file, policy, { text: '话题A 旧内容', topic: '游戏', source: 'chat', tag: 'scene' }, now);
  surfaceSeed(guard, file, policy, a.seed.id, now + DAY);
  const b = addSeed(guard, file, policy, { text: '话题A 最新进展', topic: '游戏', source: 'browse', tag: 'news' }, now + 2 * DAY);
  assert.equal(b.kind, 'merged');
  const db = loadPool(guard, file);
  assert.equal(activeSeeds(db).length, 1);
  const merged = activeSeeds(db)[0]!;
  assert.equal(merged.text, '话题A 最新进展');
  assert.equal(merged.used, 1);
  assert.equal(merged.tag, 'news');
  assert.equal(archivedSeeds(db).length, 0); // single seed, just merged in place
});

test('exact-text duplicate is rejected without touching the pool', () => {
  addSeed(guard, file, policy, { text: '完全相同的文本', tag: 'scene' }, now);
  const r = addSeed(guard, file, policy, { text: '完全相同的文本', tag: 'scene' }, now + 1);
  assert.equal(r.kind, 'duplicate');
  assert.equal(activeSeeds(loadPool(guard, file)).length, 1);
});

test('rule 4 (pool cap): full pool evicts the lowest score before inserting', () => {
  // shrink cap via a local policy clone
  const small: Policy = { ...policy, seeds: { ...policy.seeds, maxActive: 2 } };
  addSeed(guard, file, small, { text: '旧闻一条', tag: 'news', source: 'chat' }, now - 10 * DAY);
  addSeed(guard, file, small, { text: '新鲜一条', tag: 'scene', source: 'chat' }, now);
  const r = addSeed(guard, file, small, { text: '新来一条', tag: 'scene', source: 'chat' }, now + 1);
  assert.equal(r.kind, 'added');
  assert.ok(r.evicted);
  assert.equal(r.evicted!.text, '旧闻一条'); // stalest evidence, lowest freshness
  const db = loadPool(guard, file);
  assert.equal(activeSeeds(db).length, 2);
  assert.equal(archivedSeeds(db)[0]!.retireReason, 'pool_cap');
});

test('rule 4 protection: handwritten seeds survive while unprotected exist', () => {
  const small: Policy = { ...policy, seeds: { ...policy.seeds, maxActive: 2 } };
  addSeed(guard, file, small, { text: '手写保护种子', tag: 'scene', source: 'hand' }, now - 20 * DAY);
  addSeed(guard, file, small, { text: '普通种子', tag: 'scene', source: 'chat' }, now - 15 * DAY);
  const r = addSeed(guard, file, small, { text: '新种子', tag: 'scene', source: 'chat' }, now);
  assert.equal(r.evicted!.text, '普通种子');
});

test('eviction score is monotonic in freshness, unused-ness and confidence', () => {
  const mk = (over: Partial<Parameters<typeof evictionScore>[0]>) => evictionScore(
    {
      id: 'sx', text: '', topic: '', tag: 'scene', source: 'chat', confidence: 0.5,
      protected: false, used: 0, bornAt: '2026-09-01T00:00:00.000Z',
      expiresAt: '2026-11-01T00:00:00.000Z', lastUsedAt: null,
      lastEvidenceAt: '2026-09-05T00:00:00.000Z', status: 'active',
      ...over,
    } as never,
    policy,
    now,
  );
  const fresher = mk({ lastEvidenceAt: '2026-09-06T00:00:00.000Z' });
  const staler = mk({ lastEvidenceAt: '2026-08-01T00:00:00.000Z' });
  assert.ok(fresher > staler);
  const unusedSeed = mk({});
  const usedSeed = mk({ used: 2 });
  assert.ok(unusedSeed > usedSeed);
  const confident = mk({ confidence: 0.9 });
  const dubious = mk({ confidence: 0.1 });
  assert.ok(confident > dubious);
});

test('deliberate archive (completed) works and persists', () => {
  const r = addSeed(guard, file, policy, { text: '已完成的事项', tag: 'promise' }, now);
  const s = archiveSeedById(guard, file, r.seed.id, 'completed', now + 1);
  assert.equal(s!.retireReason, 'completed');
  assert.equal(activeSeeds(loadPool(guard, file)).length, 0);
});

test('pickEvictionVictim returns null on an empty pool', () => {
  assert.equal(pickEvictionVictim(loadPool(guard, file), policy, now), null);
});
