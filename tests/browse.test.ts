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
  adviseWander,
  browseStatePath,
  completeWander,
  emptyBrowseState,
  inWanderWindow,
  normalizeBrowseState,
  pickFocus,
  resolveSchedule,
} from '../src/browse/browse.js';

// Wander windows are wall-clock windows resolved in the *process* time zone, and
// the fixtures below are written as +08:00 instants. Pin the zone so the suite
// gives the same verdict on a developer machine and on a CI runner (UTC).
process.env.TZ = 'Asia/Shanghai';

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;
let paths: ReturnType<typeof workspace>;
let policy: Policy;

const NOON = new Date('2026-09-06T12:30:00.000+08:00');

beforeEach(() => {
  sandbox = sandboxDir('hb-browse-');
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  paths = initWorkspace();
  guard = createPathGuard(paths.dataDir);
  policy = loadPolicy(guard, paths.configDir, paths.settingsDir);
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
});

test('inWanderWindow matches noon/evening windows only', () => {
  assert.equal(inWanderWindow(NOON, policy.browse.windows), '11:00-15:00');
  assert.equal(inWanderWindow(new Date('2026-09-06T18:00:00.000+08:00'), policy.browse.windows), '17:00-21:00');
  assert.equal(inWanderWindow(new Date('2026-09-06T09:00:00.000+08:00'), policy.browse.windows), null);
  assert.equal(inWanderWindow(new Date('2026-09-06T16:00:00.000+08:00'), policy.browse.windows), null);
});

test('H-14: a wander window crossing midnight still matches', () => {
  const windows = [{ start: '22:00', end: '02:00' }];
  assert.equal(inWanderWindow(new Date('2026-09-06T22:00:00.000+08:00'), windows), '22:00-02:00');
  assert.equal(inWanderWindow(new Date('2026-09-06T23:30:00.000+08:00'), windows), '22:00-02:00');
  assert.equal(inWanderWindow(new Date('2026-09-07T01:15:00.000+08:00'), windows), '22:00-02:00');
  assert.equal(inWanderWindow(new Date('2026-09-07T02:00:00.000+08:00'), windows), null); // right-open
  assert.equal(inWanderWindow(new Date('2026-09-06T12:00:00.000+08:00'), windows), null);
  // a malformed entry never matches, and does not poison the entries after it
  assert.equal(inWanderWindow(NOON, [{ start: 'oops', end: '15:00' }]), null);
  assert.equal(inWanderWindow(NOON, [{ start: 'oops', end: '15:00' }, { start: '11:00', end: '15:00' }]), '11:00-15:00');
});

test('H-65: a malformed browse state degrades to defaults instead of throwing', () => {
  assert.deepEqual(normalizeBrowseState(null), emptyBrowseState());
  assert.deepEqual(normalizeBrowseState({ wander: {} }), emptyBrowseState());
  const half = normalizeBrowseState({ wander: { focusHistory: { a: 1, b: 'x' }, last_wander_at: 'soon' } });
  assert.deepEqual(half.wander.focusHistory, { a: 1 });
  assert.equal(half.wander.last_wander_at, 0);
  // legacy pre-H-12 watchlist keys are ignored rather than carried forward
  const legacy = normalizeBrowseState({ targets: { dsh: { seen: 'npm:1' } }, last_check_at: 123 });
  assert.deepEqual(legacy, emptyBrowseState());
  assert.deepEqual(normalizeBrowseState({ wander: { focusCount: { a: Number.NaN, b: 2 } } }).wander.focusCount, { b: 2 });
});

test('adviseWander: outside window -> skipped with time', () => {
  const a = adviseWander(guard, paths, policy, new Date('2026-09-06T09:00:00.000+08:00'));
  assert.equal(a.focus, null);
  assert.match(a.skipped!, /window/);
});

test('adviseWander: inside window first time -> advice with query', () => {
  const a = adviseWander(guard, paths, policy, NOON);
  assert.equal(a.skipped, null);
  assert.ok(a.focus);
  assert.match(a.query!, /2026 最新/);
});

test('adviseWander: min-interval blocks a second visit within 4h', () => {
  completeWander(guard, paths, 'AI 模型消息', NOON.getTime() - 3600_000);
  const a = adviseWander(guard, paths, policy, NOON);
  assert.equal(a.skipped, 'min-interval');
});

test('adviseWander: focus cooldown rotates to the next interest (3 days)', () => {
  const used = 'AI 模型消息';
  completeWander(guard, paths, used, NOON.getTime() - 3 * 86_400_000 + 60_000); // just inside cooldown
  const a = adviseWander(guard, paths, policy, NOON);
  assert.notEqual(a.focus, used);
  assert.ok(a.focus);
});

test('pickFocus round-robins by least-recent history', () => {
  const interests = { interests: ['甲', '乙', '丙'], _schedule: { focus_cooldown_days: 0 } };
  const st = {
    wander: { focusHistory: { 甲: 5, 乙: 2 } as Record<string, number>, focusCount: {} as Record<string, number>, last_wander_at: 0 },
  };
  assert.equal(pickFocus(st, interests, 10), '丙');
  st.wander.focusHistory['丙'] = 9;
  assert.equal(pickFocus(st, interests, 10), '乙');
});

test('completeWander records throttle timestamps (browse.json encrypted)', () => {
  const r = completeWander(guard, paths, '独立游戏', Date.now());
  assert.equal(r.count, 1);
  const st = fs.readFileSync(browseStatePath(paths)).toString('utf8');
  // encrypted at rest: the file must NOT contain the focus in plaintext
  assert.equal(st.includes('独立游戏'), false);
  assert.equal(st.slice(0, 5), 'KHBV1');
});

// ── M4: refill wander (2026-09-18 spec ⑥) ─────────────────────────────────

import {
  adviseRefillWander,
  REFILL_MAX_PER_DAY,
  REFILL_TOPIC_THRESHOLD,
} from '../src/browse/browse.js';
import { addSeed, loadPool, normalizeCategory, seedsFilePath, activeSeeds } from '../src/seeds/pool.js';

const seedFile = () => seedsFilePath(paths.dataDir);

test('spec ⑥: refill triggers at topic<=4, bypasses window and min-interval', () => {
  // off-window late night + min-interval exhausted: normal wander would skip
  const night = new Date('2026-09-06T23:30:00.000+08:00');
  for (let i = 0; i < REFILL_TOPIC_THRESHOLD; i += 1) {
    addSeed(guard, seedFile(), policy, { text: `话题 ${i}`, topic: `t${i}`, source: 'browse', tag: 'scene' }, night.getTime() + i);
  }
  const advice = adviseRefillWander(guard, paths, policy, night);
  assert.equal(advice.skipped, null, 'refill fires despite off-window and pool status');
  assert.ok(advice.focus, 'a focus is picked');
  assert.match(advice.query!, /2026 最新/);
  // one more topic seed (5 > 4) and it stands down
  addSeed(guard, seedFile(), policy, { text: '话题 补充', topic: 't9', source: 'browse', tag: 'scene' }, night.getTime() + 10);
  const over = adviseRefillWander(guard, paths, policy, night);
  assert.match(over.skipped!, /topic-stock-ok/);
});

test('spec ⑥: daily cap 2 registered via completeWander refill flag', () => {
  const noon = new Date('2026-09-06T12:30:00.000+08:00');
  for (let i = 0; i < 2; i += 1) {
    addSeed(guard, seedFile(), policy, { text: `话题 ${i}`, topic: `t${i}`, source: 'browse', tag: 'scene' }, noon.getTime() + i);
  }
  completeWander(guard, paths, 'AI 模型消息', noon.getTime(), { refill: true });
  const once = adviseRefillWander(guard, paths, policy, noon);
  assert.equal(once.skipped, null, 'second refill of the day still allowed');
  completeWander(guard, paths, '独立游戏', noon.getTime(), { refill: true });
  const capped = adviseRefillWander(guard, paths, policy, noon);
  assert.match(capped.skipped!, /refill-daily-cap\(2\)/);
  // non-refill wander does NOT consume the daily quota
  completeWander(guard, paths, '网络热梗', noon.getTime());
  const stillCapped = adviseRefillWander(guard, paths, policy, noon);
  assert.match(stillCapped.skipped!, /refill-daily-cap\(2\)/);
  // next local day resets the quota
  const tomorrow = new Date(noon.getTime() + 24 * 3600_000);
  const nextDay = adviseRefillWander(guard, paths, policy, tomorrow);
  assert.equal(nextDay.skipped, null);
});

test('spec ⑥: focus cooldown (3d) still applies to refill', async () => {
  const noon = new Date('2026-09-06T12:30:00.000+08:00');
  addSeed(guard, seedFile(), policy, { text: '话题 0', topic: 't0', source: 'browse', tag: 'scene' }, noon.getTime());
  const cooled = ['AI 模型消息', 'DSH 生态消息', '独立游戏'];
  for (const f of cooled) completeWander(guard, paths, f, noon.getTime());
  // pickFocus round-robins: the refill focus must not be one of the cooled ones
  const advice = adviseRefillWander(guard, paths, policy, noon);
  assert.ok(advice.focus, 'factory list has 14 interests, a fresh one exists');
  assert.ok(!cooled.includes(advice.focus!), 'cooled focus was not picked');
  // cool down every factory interest -> refill has nowhere to go
  const { loadInterests } = await import('../src/browse/browse.js');
  for (const f of loadInterests(paths).interests ?? []) {
    completeWander(guard, paths, f, noon.getTime());
  }
  const drained = adviseRefillWander(guard, paths, policy, noon);
  assert.equal(drained.skipped, 'no-focus');
});

test('spec ⑤/⑥: loadPool rows carry category so refill counting matches the pool', () => {
  const noon = new Date('2026-09-06T12:30:00.000+08:00');
  addSeed(guard, seedFile(), policy, { text: '聊天种子', source: 'chat' }, noon.getTime());
  addSeed(guard, seedFile(), policy, { text: '话题种子', source: 'browse', tag: 'scene' }, noon.getTime());
  const db = loadPool(guard, seedFile());
  const cats = activeSeeds(db).map((s) => normalizeCategory(s.category)).sort();
  assert.deepEqual(cats, ['chat', 'topic']);
});

// ── H-69: `interests._schedule` drives the wander flow ───────────────────

test('H-69: resolveSchedule prefers _schedule and falls back to policy.browse', () => {
  const fallback = resolveSchedule({ interests: [] }, policy);
  assert.equal(fallback.minIntervalHours, policy.browse.minIntervalHours);
  assert.equal(fallback.maxSeedsPerFocus, policy.browse.maxSeedsPerVisit);
  assert.equal(fallback.dailySessions, 0);

  const custom = resolveSchedule(
    { _schedule: { daily_sessions: 3, focus_per_session: 2, max_seeds_per_focus: 5, focus_cooldown_days: 7, min_interval_hours: 1 } },
    policy,
  );
  assert.equal(custom.dailySessions, 3);
  assert.equal(custom.focusPerSession, 2);
  assert.equal(custom.maxSeedsPerFocus, 5);
  assert.equal(custom.focusCooldownDays, 7);
  assert.equal(custom.minIntervalHours, 1);
});

test('H-69: daily_sessions caps the day and max_seeds_per_focus reaches the advice', () => {
  fs.mkdirSync(paths.settingsDir, { recursive: true });
  fs.writeFileSync(path.join(paths.settingsDir, 'interests.json'), JSON.stringify({
    interests: ['测试话题'],
    _schedule: { daily_sessions: 1, max_seeds_per_focus: 4, min_interval_hours: 0 },
  }), 'utf8');

  const first = adviseWander(guard, paths, policy, NOON);
  assert.equal(first.focus, '测试话题');
  assert.equal(first.maxSeeds, 4);

  completeWander(guard, paths, first.focus!, NOON.getTime());
  const second = adviseWander(guard, paths, policy, NOON);
  assert.equal(second.focus, null);
  assert.match(second.skipped ?? '', /daily-sessions/);
});
