// Three-layer seed dedup + noMerge opt-out (2026-10-29): exact text,
// NFKC-normalized text, bigram Dice similarity — against actives AND recently
// archived; wander passes noMerge so one focus's several items all survive.

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
  SEED_SIMILARITY_THRESHOLD,
  activeSeeds,
  addSeed,
  archiveSeedById,
  loadPool,
  normalizeSeedText,
  seedSimilarity,
  seedsFilePath,
  type SeedAuditFn,
} from '../src/seeds/pool.js';

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;
let file = '';
let policy: Policy;
const now = Date.parse('2026-09-06T12:00:00.000Z');

beforeEach(() => {
  sandbox = sandboxDir('hb-wander-dedup-');
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  guard = createPathGuard(workspace().dataDir);
  file = seedsFilePath(workspace().dataDir);
  policy = loadPolicy(guard, workspace().configDir, workspace().settingsDir);
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
});

test('normalizeSeedText: full-width -> half-width, lowercase, strips whitespace/punctuation', () => {
  assert.equal(normalizeSeedText('ＧＰＴ－５ 正式发布了！'), normalizeSeedText('gpt-5正式发布了'));
  assert.equal(normalizeSeedText('ＡＩ，模型！'), 'ai模型');
});

test('seedSimilarity: identical normalization is 1, near-duplicate title > threshold, unrelated low', () => {
  assert.equal(seedSimilarity('OpenAI 发布了新模型', 'ｏｐｅｎａｉ发布了新模型'), 1);
  assert.equal(seedSimilarity('OpenAI 发布了新模型', 'OpenAI 发布了新大模型') > SEED_SIMILARITY_THRESHOLD, true);
  assert.equal(seedSimilarity('杀戮尖塔的新DLC加入了蜂蜜流', '今晚的月色真美啊') < 0.5, true);
});

test('exact duplicate: same raw text -> duplicate with reason exact', () => {
  const first = addSeed(guard, file, policy, { text: '某厂商发布了新款显卡', tag: 'news', source: 'browse' }, now);
  assert.equal(first.kind, 'added');
  const again = addSeed(guard, file, policy, { text: '某厂商发布了新款显卡', tag: 'news', source: 'browse' }, now + 1);
  assert.equal(again.kind, 'duplicate');
  assert.equal(again.reason, 'exact');
  assert.equal(again.seed.id, first.seed.id);
  assert.equal(activeSeeds(loadPool(guard, file)).length, 1);
});

test('normalized duplicate: whitespace / full-width variants collide', () => {
  const first = addSeed(guard, file, policy, { text: 'ＧＰＴ－５ 正式发布了！', tag: 'news', source: 'browse' }, now);
  assert.equal(first.kind, 'added');
  const again = addSeed(guard, file, policy, { text: 'gpt-5 正式发布了！！', tag: 'news', source: 'browse' }, now + 1);
  assert.equal(again.kind, 'duplicate');
  assert.equal(again.reason, 'normalized');
  assert.equal(again.seed.id, first.seed.id);
  assert.equal(activeSeeds(loadPool(guard, file)).length, 1);
});

test('similar duplicate: near-duplicate headline above threshold -> duplicate with reason similar', () => {
  const first = addSeed(guard, file, policy, { text: 'OpenAI 发布了新模型', tag: 'news', source: 'browse' }, now);
  assert.equal(first.kind, 'added');
  const again = addSeed(guard, file, policy, { text: 'OpenAI 发布了新大模型', tag: 'news', source: 'browse' }, now + 1);
  assert.equal(again.kind, 'duplicate');
  assert.equal(again.reason, 'similar');
  assert.equal(again.seed.id, first.seed.id);
  assert.equal(activeSeeds(loadPool(guard, file)).length, 1);
});

test('dissimilar text inserts normally beside existing seeds', () => {
  addSeed(guard, file, policy, { text: 'OpenAI 发布了新模型', tag: 'news', source: 'browse' }, now);
  const r = addSeed(guard, file, policy, { text: '杀戮尖塔的新DLC加入了蜂蜜流', tag: 'news', source: 'browse' }, now + 1);
  assert.equal(r.kind, 'added');
  const db = loadPool(guard, file);
  assert.equal(activeSeeds(db).length, 2);
});

test('recently archived seeds are in the dedup scope too', () => {
  const first = addSeed(guard, file, policy, { text: '某新闻事件有了后续', tag: 'news', source: 'browse' }, now);
  archiveSeedById(guard, file, first.seed.id, 'completed', now + 1);
  assert.equal(activeSeeds(loadPool(guard, file)).length, 0);
  const again = addSeed(guard, file, policy, { text: '某新闻事件有了后续', tag: 'news', source: 'browse' }, now + 2);
  assert.equal(again.kind, 'duplicate');
  assert.equal(again.reason, 'exact');
});

test('audit: seed_duplicate carries id + similarity; exact hits score nothing', () => {
  const events: Record<string, unknown>[] = [];
  const audit: SeedAuditFn = (entry) => events.push(entry);
  addSeed(guard, file, policy, { text: 'OpenAI 发布了新模型', tag: 'news', source: 'browse' }, now, audit);
  addSeed(guard, file, policy, { text: 'OpenAI 发布了新大模型', tag: 'news', source: 'browse' }, now + 1, audit);
  addSeed(guard, file, policy, { text: 'OpenAI 发布了新模型', tag: 'news', source: 'browse' }, now + 2, audit);
  const dupes = events.filter((e) => e.event === 'seed_duplicate');
  assert.equal(dupes.length, 2);
  const similar = dupes[0]!;
  assert.equal(similar.reason, 'similar');
  assert.equal(typeof similar.similarity, 'number');
  assert.equal(similar.similarity as number > SEED_SIMILARITY_THRESHOLD, true);
  const exact = dupes[1]!;
  assert.equal(exact.reason, 'exact');
  assert.equal('similarity' in exact, false);
});

test('noMerge: true keeps every item of one focus as its own seed', () => {
  const texts = ['第一款新作明年发售', '第二款新作宣布跳票', '第三款新作放出试玩'];
  const kinds: string[] = [];
  texts.forEach((text, i) => {
    const r = addSeed(
      guard, file, policy,
      { text, topic: '独立游戏', tag: 'news', source: 'browse', noMerge: true },
      now + i,
    );
    kinds.push(r.kind);
  });
  assert.deepEqual(kinds, ['added', 'added', 'added']);
  assert.equal(activeSeeds(loadPool(guard, file)).length, 3);
});

test('noMerge default: same-topic items still collapse into one (§4.3 unchanged)', () => {
  const first = addSeed(guard, file, policy, { text: '第一款新作明年发售', topic: '独立游戏', tag: 'news', source: 'browse' }, now);
  const second = addSeed(guard, file, policy, { text: '第二款新作宣布跳票', topic: '独立游戏', tag: 'news', source: 'browse' }, now + 1);
  assert.equal(first.kind, 'added');
  assert.equal(second.kind, 'merged');
  const actives = activeSeeds(loadPool(guard, file));
  assert.equal(actives.length, 1);
  assert.equal(actives[0]!.text, '第二款新作宣布跳票'); // brief takes the latest
});
