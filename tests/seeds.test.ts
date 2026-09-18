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
  savePool,
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
  // explicit topic category: the default source 'chat' now carries the spec ④
  // once-only limit, which is covered by its own test below.
  const r = addSeed(guard, file, policy, { text: '聊过两次的话题', tag: 'scene', source: 'browse' }, now);
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
  // both browse-sourced: source 'chat' now implies category 'chat' (spec ④),
  // which would retire the first seed after ONE surfacing before the merge.
  const a = addSeed(guard, file, policy, { text: '话题A 旧内容', topic: '游戏', source: 'browse', tag: 'scene' }, now);
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

// ── M1: category (2026-09-18 spec ⑤④) ────────────────────────────────────

test('spec ⑤: category defaults from source; loadPool normalizes legacy rows to topic', async () => {
  const chat = addSeed(guard, file, policy, { text: '聊天长出来的素材', source: 'chat' }, now);
  assert.equal(chat.seed.category, 'chat');
  const topic = addSeed(guard, file, policy, { text: '闲逛带回的素材', source: 'browse' }, now + 1);
  assert.equal(topic.seed.category, 'topic');
  const explicit = addSeed(guard, file, policy, { text: '显式指定', source: 'browse', category: 'chat' }, now + 2);
  assert.equal(explicit.seed.category, 'chat');
  // legacy on-disk row without category (pre-v1.5) loads as topic, unknown value too
  const { saveEncryptedText } = await import('../src/vault/vault.js');
  const legacy = [
    JSON.stringify({ id: 's900', text: '旧行', topic: '旧行', tag: 'scene', source: 'browse', confidence: 0.4, protected: false, used: 0, bornAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-11-01T00:00:00.000Z', lastUsedAt: null, lastEvidenceAt: '2026-09-01T00:00:00.000Z', status: 'active' }),
    JSON.stringify({ id: 's901', text: '野值行', topic: '野值行', tag: 'scene', source: 'browse', category: 'bogus', confidence: 0.4, protected: false, used: 0, bornAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-11-01T00:00:00.000Z', lastUsedAt: null, lastEvidenceAt: '2026-09-01T00:00:00.000Z', status: 'active' }),
  ].join('\n');
  saveEncryptedText(guard, file, legacy + '\n');
  const db = loadPool(guard, file);
  const s900 = db.seeds.find((s) => s.id === 's900')!;
  const s901 = db.seeds.find((s) => s.id === 's901')!;
  assert.equal(s900.category, 'topic');
  assert.equal(s901.category, 'topic');
});

test('spec ⑤: topic cap 16 evicts within topic, chat pool untouched', () => {
  for (let i = 0; i < 16; i += 1) {
    addSeed(guard, file, policy, { text: `话题素材 ${i}`, topic: `t${i}`, source: 'browse', tag: 'scene' }, now + i);
  }
  const chatSeed = addSeed(guard, file, policy, { text: '聊天素材不受挤', source: 'chat' }, now + 100);
  const r = addSeed(guard, file, policy, { text: '第 17 条话题', source: 'browse', tag: 'scene' }, now + 101);
  assert.equal(r.kind, 'added');
  assert.ok(r.evicted, 'oldest topic seed was evicted');
  assert.notEqual(r.evicted!.id, chatSeed.seed.id);
  const db = loadPool(guard, file);
  const topicCount = activeSeeds(db).filter((s) => s.category === 'topic').length;
  const chatCount = activeSeeds(db).filter((s) => s.category === 'chat').length;
  assert.equal(topicCount, 16);
  assert.equal(chatCount, 1);
});

test('spec ⑤: chat cap 14 evicts within chat only', () => {
  for (let i = 0; i < 14; i += 1) {
    addSeed(guard, file, policy, { text: `聊天素材 ${i}`, topic: `c${i}`, source: 'chat' }, now + i);
  }
  const topicSeed = addSeed(guard, file, policy, { text: '话题素材不受挤', source: 'browse', tag: 'scene' }, now + 100);
  const r = addSeed(guard, file, policy, { text: '第 15 条聊天', source: 'chat' }, now + 101);
  assert.equal(r.kind, 'added');
  assert.ok(r.evicted);
  assert.notEqual(r.evicted!.id, topicSeed.seed.id);
  const db = loadPool(guard, file);
  assert.equal(activeSeeds(db).filter((s) => s.category === 'chat').length, 14);
  assert.equal(activeSeeds(db).filter((s) => s.category === 'topic').length, 1);
});

test('spec ④: chat seed retires after ONE surfacing without newer evidence', async () => {
  const chat = addSeed(guard, file, policy, { text: '一次就用完', source: 'chat' }, now);
  const s = surfaceSeed(guard, file, policy, chat.seed.id, now + 3600_000);
  assert.equal(s!.used, 1);
  assert.equal(s!.status, 'archived');
  assert.equal(s!.retireReason, 'consumed');
  // topic seed under the same conditions survives (policy retireAfterUsed=2)
  const topic = addSeed(guard, file, policy, { text: '话题要用两次', source: 'browse', tag: 'scene' }, now);
  const t = surfaceSeed(guard, file, policy, topic.seed.id, now + 3600_000);
  assert.equal(t!.used, 1);
  assert.equal(t!.status, 'active');
  // and gc agrees with surface on the chat limit
  const chat2 = addSeed(guard, file, policy, { text: 'gc 也认一次', source: 'chat' }, now);
  const db2 = loadPool(guard, file);
  const s2 = db2.seeds.find((x) => x.id === chat2.seed.id)!;
  s2.used = 1;
  s2.lastUsedAt = new Date(now + 3600_000).toISOString();
  savePool(guard, file, db2);
  const report = gcPool(guard, file, policy, now + 7200_000);
  assert.equal(report.consumed, 1);
});
