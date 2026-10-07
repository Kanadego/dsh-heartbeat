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
  deleteSeed,
  restoreSeed,
  type SeedAuditFn,
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

test('H-22: evidence newer than the previous use spares a seed at its limit', () => {
  // Same path, same limit — the only difference is the evidence watermark.
  const spared = addSeed(guard, file, policy, { text: '有新证据的话题', source: 'browse', tag: 'scene' }, now);
  surfaceSeed(guard, file, policy, spared.seed.id, now + DAY);
  const db = loadPool(guard, file);
  db.seeds.find((x) => x.id === spared.seed.id)!.lastEvidenceAt = new Date(now + DAY + 1000).toISOString();
  savePool(guard, file, db);
  const s = surfaceSeed(guard, file, policy, spared.seed.id, now + 2 * DAY);
  assert.equal(s!.used, 2);
  assert.equal(s!.status, 'active'); // fresh evidence arrived after the first use

  const retired = addSeed(guard, file, policy, { text: '没有新证据的话题', source: 'browse', tag: 'scene' }, now);
  surfaceSeed(guard, file, policy, retired.seed.id, now + DAY);
  const r = surfaceSeed(guard, file, policy, retired.seed.id, now + 2 * DAY);
  assert.equal(r!.used, 2);
  assert.equal(r!.status, 'archived');
  assert.equal(r!.retireReason, 'consumed');
});

test('v1.9.0 archive cap: gc trims the archive area beyond seeds.archiveCap, oldest-retired first', () => {
  const cap = policy.seeds.archiveCap;
  // 3 fresh actives + cap+5 archived rows with staggered retiredAt
  for (let i = 0; i < 3; i++) addSeed(guard, file, policy, { text: `活跃素材 ${i}`, source: 'browse' }, now + i);
  const db0 = loadPool(guard, file);
  const actives = activeSeeds(db0);
  for (let i = 0; i < cap + 5; i++) {
    const s = actives[i % actives.length]!;
    db0.seeds.push({
      ...s,
      id: `s9${String(i).padStart(3, '0')}`,
      status: 'archived',
      retireReason: 'expired',
      retiredAt: new Date(now - (cap + 5 - i) * 1000).toISOString(), // older i = older retirement
    });
  }
  savePool(guard, file, db0);

  const report = gcPool(guard, file, policy, now);
  assert.equal(report.archiveTrimmed, 5);
  const db = loadPool(guard, file);
  const archived = archivedSeeds(db);
  assert.equal(archived.length, cap);
  // survivors are the NEWEST retired; the five oldest (x0..x4) are gone
  assert.ok(!archived.some((s) => ['s90000', 's90001', 's90002', 's90003', 's90004'].includes(s.id)));
  assert.ok(archived.some((s) => s.id === `s9${String(cap + 4).padStart(3, '0')}`));
  // active area untouched
  assert.equal(activeSeeds(db).length, 3);
});

test('v1.9.0 archive cap: at or under the cap gc trims nothing', () => {
  const cap = policy.seeds.archiveCap;
  const s = addSeed(guard, file, policy, { text: '归档一条', source: 'browse' }, now).seed;
  const db0 = loadPool(guard, file);
  const a = db0.seeds.find((x) => x.id === s.id)!;
  a.status = 'archived';
  a.retireReason = 'expired';
  a.retiredAt = new Date(now).toISOString();
  savePool(guard, file, db0);
  const report = gcPool(guard, file, policy, now + 1000);
  assert.equal(report.archiveTrimmed, 0);
  assert.equal(archivedSeeds(loadPool(guard, file)).length, 1);
  assert.ok(cap >= 1);
});

// ── v1.9.0: seed lifecycle audit ────────────────────────────────────────
// The pool used to mutate in silence. Every mutator now reports what it did
// through an optional sink; these tests pin the event names and payloads so a
// future refactor cannot quietly drop the trail again.

function collector(): { events: Record<string, unknown>[]; sink: SeedAuditFn } {
  const events: Record<string, unknown>[] = [];
  return { events, sink: (entry) => { events.push(entry); } };
}

const eventsNamed = (events: Record<string, unknown>[], name: string) => events.filter((e) => e.event === name);

test('audit: add reports the new seed, duplicate reports nothing, cap eviction is named', () => {
  const { events, sink } = collector();
  const r = addSeed(guard, file, policy, { text: '审计一条', tag: 'promise', source: 'chat' }, now, sink);
  const added = eventsNamed(events, 'seed_added');
  assert.equal(added.length, 1);
  assert.equal(added[0]!.id, r.seed.id);
  assert.equal(added[0]!.kind, 'added');
  assert.equal(added[0]!.tag, 'promise');
  assert.equal(added[0]!.source, 'chat');
  assert.equal(added[0]!.category, 'chat');
  // no text in the audit line: heartbeat.jsonl is plaintext by charter
  assert.equal(JSON.stringify(events).includes('审计一条'), false);

  const dup = addSeed(guard, file, policy, { text: '审计一条', tag: 'promise', source: 'chat' }, now + 1, sink);
  assert.equal(dup.kind, 'duplicate');
  assert.equal(events.length, 1);

  const small: Policy = { ...policy, seeds: { ...policy.seeds, maxActive: 1 } };
  const { events: ev2, sink: sink2 } = collector();
  addSeed(guard, file, small, { text: '留下的', source: 'browse' }, now, sink2);
  addSeed(guard, file, small, { text: '挤走一个', source: 'browse' }, now + 1, sink2);
  const retired = eventsNamed(ev2, 'seed_retired');
  assert.equal(retired.length, 1);
  assert.equal(retired[0]!.reason, 'pool_cap');
  assert.equal(retired[0]!.via, 'add');
});

test('audit: merge names the absorbing seed and every absorbed row', () => {
  const { events, sink } = collector();
  const first = addSeed(guard, file, policy, { text: '话题最旧', topic: '审计', source: 'browse' }, now, sink).seed;
  // two more same-topic actives, so this merge collapses two rows into the kept one
  const db0 = loadPool(guard, file);
  const row = db0.seeds.find((s) => s.id === first.id)!;
  db0.seeds.push({ ...row, id: 's777', text: '话题中旧' }, { ...row, id: 's778', text: '话题中旧2' });
  savePool(guard, file, db0);

  events.length = 0;
  const merged = addSeed(guard, file, policy, { text: '话题最新', topic: '审计', source: 'browse' }, now + 2, sink);
  assert.equal(merged.kind, 'merged');
  const added = eventsNamed(events, 'seed_added');
  assert.equal(added.length, 1);
  assert.equal(added[0]!.kind, 'merged');
  assert.equal(added[0]!.mergedFrom, 2);
  const retired = eventsNamed(events, 'seed_retired');
  assert.equal(retired.length, 2);
  for (const e of retired) {
    assert.equal(e.reason, 'completed');
    assert.equal(e.via, 'merge');
    assert.equal(e.into, merged.seed.id);
  }
});

test('audit: gc names every retirement reason and the trimmed archive rows', () => {
  const { events, sink } = collector();
  addSeed(guard, file, policy, { text: '过期新闻', tag: 'news', source: 'browse' }, now, sink);
  addSeed(guard, file, policy, { text: '冷板凳', tag: 'promise', source: 'browse' }, now, sink);
  const used = addSeed(guard, file, policy, { text: '用完了', tag: 'scene', source: 'browse' }, now, sink);
  const db = loadPool(guard, file);
  const u = db.seeds.find((s) => s.id === used.seed.id)!;
  u.used = 2;
  u.lastUsedAt = new Date(now).toISOString();
  savePool(guard, file, db);
  events.length = 0;

  gcPool(guard, file, policy, now + 22 * DAY, sink);
  const retired = eventsNamed(events, 'seed_retired');
  const reasons = retired.map((e) => e.reason).sort();
  assert.deepEqual(reasons, ['cold_bench', 'consumed', 'expired']);
  assert.ok(retired.every((e) => e.via === 'gc'));
});

test('audit: archive trimming names the rows it deleted (the only trace left)', () => {
  const cap = policy.seeds.archiveCap;
  for (let i = 0; i < 2; i++) addSeed(guard, file, policy, { text: `审计活跃 ${i}`, source: 'browse' }, now + i);
  const db0 = loadPool(guard, file);
  const base = activeSeeds(db0)[0]!;
  for (let i = 0; i < cap + 3; i++) {
    db0.seeds.push({
      ...base,
      id: `s8${String(i).padStart(3, '0')}`,
      status: 'archived',
      retireReason: 'expired',
      retiredAt: new Date(now - (cap + 3 - i) * 1000).toISOString(),
    });
  }
  savePool(guard, file, db0);
  const { events, sink } = collector();
  const report = gcPool(guard, file, policy, now, sink);
  assert.equal(report.archiveTrimmed, 3);
  const trimmed = eventsNamed(events, 'seed_archive_trimmed');
  assert.equal(trimmed.length, 1);
  assert.equal(trimmed[0]!.count, 3);
  assert.deepEqual(trimmed[0]!.ids, ['s8000', 's8001', 's8002']);
  // trimmed rows leave no other record behind
  assert.equal(archivedSeeds(loadPool(guard, file)).length, cap);
});

test('audit: surface / manual archive / restore / delete each report their own event', () => {
  const { events, sink } = collector();
  const chat = addSeed(guard, file, policy, { text: '一次用完', source: 'chat' }, now, sink);
  surfaceSeed(guard, file, policy, chat.seed.id, now + 1000, sink);
  const surfaced = eventsNamed(events, 'seed_retired');
  assert.equal(surfaced.length, 1);
  assert.equal(surfaced[0]!.reason, 'consumed');
  assert.equal(surfaced[0]!.via, 'surface');

  const s2 = addSeed(guard, file, policy, { text: '手动归档', source: 'browse' }, now + 2000, sink);
  archiveSeedById(guard, file, s2.seed.id, 'completed', now + 3000, sink);
  const manual = eventsNamed(events, 'seed_retired').at(-1)!;
  assert.equal(manual.id, s2.seed.id);
  assert.equal(manual.via, 'manual');
  assert.equal(manual.reason, 'completed');

  restoreSeed(guard, file, policy, s2.seed.id, now + 4000, sink);
  assert.deepEqual(eventsNamed(events, 'seed_restored').at(-1), { event: 'seed_restored', id: s2.seed.id });

  assert.equal(deleteSeed(guard, file, s2.seed.id, sink), true);
  assert.deepEqual(eventsNamed(events, 'seed_deleted').at(-1), { event: 'seed_deleted', id: s2.seed.id });
  // deleting a missing row reports nothing (nothing happened)
  const before = events.length;
  assert.equal(deleteSeed(guard, file, 's99999', sink), false);
  assert.equal(events.length, before);
});

test('audit: a throwing sink never breaks the pool mutation', () => {
  const boom: SeedAuditFn = () => { throw new Error('disk full'); };
  const r = addSeed(guard, file, policy, { text: '审计失败也要写入', source: 'browse' }, now, boom);
  assert.equal(r.kind, 'added');
  assert.equal(activeSeeds(loadPool(guard, file)).length, 1);
  assert.equal(gcPool(guard, file, policy, now + 1, boom).activeAfter, 1);
});

