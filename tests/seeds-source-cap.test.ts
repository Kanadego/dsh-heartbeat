// Per-source pool caps (2026-11-09): one origin must not own the pool — the
// bilibili watch history carries its own source value ('bilibili', see
// types.ts) and is capped at 6 so it cannot crowd every other source out. The
// cap is the THIRD quota dimension, checked before the category and global
// caps, LOOP-evicts inside its own source until the lane is below the cap,
// and names 'source_cap' both in the audit event AND the stored retireReason.

import { sandboxDir } from './_sandbox.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import { loadPolicy } from '../src/config/load.js';
import type { Policy } from '../src/config/schema.js';
import {
  SEED_SOURCE_CAPS,
  activeSeeds,
  addSeed,
  archivedSeeds,
  loadPool,
  pickEvictionVictim,
  savePool,
  seedsFilePath,
  type SeedAuditFn,
} from '../src/seeds/pool.js';
import type { Seed } from '../src/seeds/types.js';

const DAY = 86_400_000;
let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;
let file = '';
let policy: Policy;
let now: number;

beforeEach(() => {
  sandbox = sandboxDir('hb-seeds-source-cap-');
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  guard = createPathGuard(workspace().dataDir);
  file = seedsFilePath(workspace().dataDir);
  policy = loadPolicy(guard, workspace().configDir, workspace().settingsDir);
  now = Date.parse('2026-11-09T12:00:00.000Z');
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
});

const collector = () => {
  const events: Record<string, unknown>[] = [];
  const sink: SeedAuditFn = (entry) => events.push(entry);
  return { events, sink };
};
const eventsNamed = (events: Record<string, unknown>[], event: string) =>
  events.filter((e) => e.event === event);

test('SEED_SOURCE_CAPS declares the bilibili cap of 6 (watch history lane)', () => {
  assert.equal(SEED_SOURCE_CAPS.bilibili, 6);
  assert.equal(SEED_SOURCE_CAPS.browse, undefined, 'the wander browse lane stays uncapped');
});

test('source cap: the 7th bilibili seed evicts the OLDEST bilibili; other sources untouched', () => {
  const { events, sink } = collector();
  // 6 bilibili topic seeds (noMerge + ttlDaysOverride — the ingest shape),
  // staggered evidence so the oldest is identifiable.
  for (let i = 0; i < 6; i += 1) {
    const r = addSeed(
      guard, file, policy,
      { text: `B站历史素材 ${i}`, topic: `b${i}`, tag: 'news', source: 'bilibili', noMerge: true }, now + i, sink,
    );
    assert.equal(r.kind, 'added');
    assert.equal(r.evicted, undefined, `insert #${i + 1} must not evict (below cap)`);
  }
  // other origins in the pool: 2 chat + 1 screen news — none may be touched
  addSeed(guard, file, policy, { text: '聊天素材一', source: 'chat' }, now + 10, sink);
  addSeed(guard, file, policy, { text: '聊天素材二', source: 'chat' }, now + 11, sink);
  addSeed(guard, file, policy, { text: '截屏素材', tag: 'news', source: 'screen' }, now + 12, sink);

  const r = addSeed(
    guard, file, policy,
    { text: 'B站历史素材 6', topic: 'b6', tag: 'news', source: 'bilibili', noMerge: true }, now + 20, sink,
  );
  assert.equal(r.kind, 'added');
  assert.ok(r.evicted, 'the 7th bilibili insert evicts inside its own lane');
  assert.equal(r.evicted!.text, 'B站历史素材 0', 'the oldest bilibili seed is the victim');
  assert.equal(r.evicted!.source, 'bilibili');
  assert.equal(r.evicted!.retireReason, 'source_cap', 'stored retireReason matches the audit');
  const retired = eventsNamed(events, 'seed_retired');
  assert.equal(retired.length, 1);
  assert.equal(retired[0]!.id, r.evicted!.id);
  assert.equal(retired[0]!.reason, 'source_cap');
  assert.equal(retired[0]!.via, 'add');

  const db = loadPool(guard, file);
  const bySource = (source: string) => activeSeeds(db).filter((s) => s.source === source);
  assert.equal(bySource('bilibili').length, 6, 'bilibili lane refilled to its cap');
  assert.equal(bySource('chat').length, 2, 'chat lane untouched');
  assert.equal(bySource('screen').length, 1, 'screen lane untouched');
  assert.ok(bySource('screen').every((s) => s.tag === 'news'), 'the news-tag seed survived');
});

test('source cap: below the cap nothing is evicted (3 bilibili -> 4th inserts clean)', () => {
  const { events, sink } = collector();
  for (let i = 0; i < 3; i += 1) {
    addSeed(guard, file, policy, { text: `B站历史素材 ${i}`, topic: `b${i}`, tag: 'news', source: 'bilibili', noMerge: true }, now + i, sink);
  }
  const r = addSeed(
    guard, file, policy,
    { text: 'B站历史素材 3', topic: 'b3', tag: 'news', source: 'bilibili', noMerge: true }, now + 10, sink,
  );
  assert.equal(r.kind, 'added');
  assert.equal(r.evicted, undefined, 'no eviction while the source is under its cap');
  assert.equal(eventsNamed(events, 'seed_retired').length, 0);
  assert.equal(activeSeeds(loadPool(guard, file)).filter((s) => s.source === 'bilibili').length, 4);
});

test('source cap: the boundary is exact (6 in, no eviction; the 7th evicts)', () => {
  for (let i = 0; i < 6; i += 1) {
    const r = addSeed(guard, file, policy, { text: `边界素材 ${i}`, topic: `e${i}`, tag: 'scene', source: 'bilibili', noMerge: true }, now + i);
    assert.equal(r.evicted, undefined, `bilibili #${i + 1} sits at or under the cap`);
  }
  assert.equal(activeSeeds(loadPool(guard, file)).length, 6);
  const r = addSeed(guard, file, policy, { text: '边界素材 6', topic: 'e6', tag: 'scene', source: 'bilibili', noMerge: true }, now + 100);
  assert.ok(r.evicted, 'crossing the cap evicts');
  assert.equal(activeSeeds(loadPool(guard, file)).filter((s) => s.source === 'bilibili').length, 6);
});

test('source cap converges: a stock already over the cap drains to the cap on the next add', () => {
  const { events, sink } = collector();
  // fill to the cap the ordinary way (6 inserts, no eviction); tag 'scene'
  // (60d TTL) so the hand-placed stale rows below are unambiguously the
  // lowest-scoring victims and the eviction ORDER is deterministic.
  for (let i = 0; i < 6; i += 1) {
    addSeed(guard, file, policy, { text: `存量素材 ${i}`, topic: `s${i}`, tag: 'scene', source: 'bilibili', noMerge: true }, now + i, sink);
  }
  // hand-place 2 MORE active bilibili rows on disk (simulating an over-cap
  // stock left behind by a cap change): 8 active bilibili in total.
  const db = loadPool(guard, file);
  const extra: Seed[] = [8, 9].map((n, k) => ({
    id: `s90${n}`,
    text: `超限存货 ${k}`,
    topic: `x${k}`,
    tag: 'scene' as const,
    source: 'bilibili' as const,
    category: 'topic' as const,
    confidence: 0.4,
    protected: false,
    used: 0,
    bornAt: new Date(now - 3 * DAY).toISOString(),
    expiresAt: new Date(now + 2 * DAY).toISOString(),
    lastUsedAt: null,
    // oldest evidence of the whole lane -> first eviction victims
    lastEvidenceAt: new Date(now - (6 - k) * DAY).toISOString(),
    status: 'active' as const,
  }));
  db.seeds.push(...extra);
  savePool(guard, file, db);
  assert.equal(activeSeeds(loadPool(guard, file)).filter((s) => s.source === 'bilibili').length, 8);

  // one add on the over-cap stock: the loop must drain the lane to the cap
  const r = addSeed(
    guard, file, policy,
    { text: 'B站历史素材 新', topic: 'bnew', tag: 'news', source: 'bilibili', noMerge: true }, now + 30, sink,
  );
  assert.equal(r.kind, 'added');
  const lane = activeSeeds(loadPool(guard, file)).filter((s) => s.source === 'bilibili');
  assert.equal(lane.length, 6, '8 stock + 1 add -> drained to exactly the cap');
  // 8 -> evict until 5 remain -> insert -> 6: three victims, oldest first
  assert.ok(r.evicted, 'the last victim is surfaced on the result');
  assert.equal(r.evicted!.retireReason, 'source_cap');
  const retired = eventsNamed(events, 'seed_retired');
  assert.equal(retired.length, 3, 'three rows retired by the single add');
  assert.ok(retired.every((e) => e.reason === 'source_cap'), 'every audit names source_cap');
  assert.deepEqual(retired.map((e) => e.id), ['s908', 's909', 's1'], 'oldest evidence evicted first');
  assert.ok(lane.every((s) => !['s908', 's909', 's1'].includes(s.id)));
});

test('pickEvictionVictim: the optional source filter scopes the competition', () => {
  addSeed(guard, file, policy, { text: '旧的 bilibili', topic: 'b0', tag: 'scene', source: 'bilibili', noMerge: true }, now - 5 * DAY);
  addSeed(guard, file, policy, { text: '新的 bilibili', topic: 'b1', tag: 'scene', source: 'bilibili', noMerge: true }, now);
  // evidence far older than anything else so it is unambiguously the global worst
  addSeed(guard, file, policy, { text: '更旧的聊天', source: 'chat' }, now - 40 * DAY);
  const db = loadPool(guard, file);
  const biliVictim = pickEvictionVictim(db, policy, now, undefined, 'bilibili');
  assert.equal(biliVictim!.text, '旧的 bilibili', 'only bilibili seeds compete');
  assert.equal(pickEvictionVictim(db, policy, now, undefined, 'hand'), null, 'no hand seeds -> no victim');
  // existing callers (no filter) are unaffected
  const unfiltered = pickEvictionVictim(db, policy, now);
  assert.equal(unfiltered!.text, '更旧的聊天', 'unfiltered still sees every source');
});

test('source cap: uncapped sources keep the plain pool_cap audit (category/global unchanged)', () => {
  // a shrunken global cap with an UNCAPPED source (chat): the source check is
  // a no-op and the global cap still fires with reason pool_cap.
  const { events, sink } = collector();
  const small: Policy = { ...policy, seeds: { ...policy.seeds, maxActive: 1 } };
  addSeed(guard, file, small, { text: '留下的', source: 'chat' }, now, sink);
  const r = addSeed(guard, file, small, { text: '挤走一个', source: 'chat' }, now + 1, sink);
  assert.equal(r.evicted!.text, '留下的');
  assert.equal(r.evicted!.retireReason, 'pool_cap');
  const retired = eventsNamed(events, 'seed_retired');
  assert.equal(retired.length, 1);
  assert.equal(retired[0]!.reason, 'pool_cap', 'uncapped source keeps the plain pool_cap audit');
});

test('source cap: protected bilibili seeds still yield to the cap when they are all there is', () => {
  // pickEvictionVictim falls back to protected actives when nothing else
  // competes — the cap must not dead-lock the lane.
  for (let i = 0; i < 6; i += 1) {
    addSeed(guard, file, policy, { text: `受保护素材 ${i}`, topic: `p${i}`, tag: 'scene', source: 'hand', noMerge: true, category: 'topic' }, now + i);
  }
  const db = loadPool(guard, file);
  assert.equal(db.seeds.filter((s) => s.source === 'hand').length, 6);
  // hand is uncapped; simulate the bilibili lane by rewriting the source in
  // memory only (in-memory view, not persisted) so every lane member is
  // protected and the cap's fallback path is exercised.
  for (const s of db.seeds) s.source = 'bilibili';
  const victim = pickEvictionVictim(db, policy, now, undefined, 'bilibili');
  assert.ok(victim, 'a fully-protected lane still yields a victim (fallback)');
});

test('archived bilibili rows keep the source_cap retireReason on disk', () => {
  const r = addSeed(guard, file, policy, { text: '占位素材 A', topic: 'a0', tag: 'news', source: 'bilibili', noMerge: true }, now);
  addSeed(guard, file, policy, { text: '占位素材 B', topic: 'a1', tag: 'news', source: 'bilibili', noMerge: true }, now + 1);
  const db = loadPool(guard, file);
  // archive one bilibili row manually then verify a cap-evicted row persists
  // with the same reason spelling (archive list vs audit consistency).
  const victim = db.seeds.find((s) => s.id === r.seed.id)!;
  victim.status = 'archived';
  victim.retireReason = 'source_cap';
  victim.retiredAt = new Date(now + 2).toISOString();
  savePool(guard, file, db);
  const row = loadPool(guard, file).seeds.find((s) => s.id === r.seed.id)!;
  assert.equal(row.retireReason, 'source_cap');
  assert.ok(archivedSeeds(loadPool(guard, file)).some((s) => s.retireReason === 'source_cap'));
});
