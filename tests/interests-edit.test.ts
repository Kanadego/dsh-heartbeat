// Interests editing tests (v1.4.0): 首编继承出厂 semantics, add/remove rules,
// wander-window validation. The factory file is the real in-repo
// config/interests.json (14 rows), read-only for these tests.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import {
  MAX_INTERESTS,
  addInterest,
  ensureUserLayer,
  normalizeInterest,
  parseWindow,
  readEffective,
  removeInterest,
  setWanderWindows,
  userInterestsPath,
} from '../src/browse/interests-edit.js';

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-interests-'));
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  guard = createPathGuard(workspace().dataDir);
});

after(() => {
  resetWorkspaceForTest();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('readEffective: factory view without creating the user layer', () => {
  const doc = readEffective(workspace());
  assert.equal(doc.interests.length, 14);
  assert.equal(fs.existsSync(userInterestsPath(workspace())), false);
});

test('addInterest first edit seeds the factory rows verbatim', () => {
  const r = addInterest(guard, workspace(), '天文摄影');
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(userInterestsPath(workspace())), true);
  assert.equal(r.doc.interests.length, 15);
  assert.equal(r.doc.interests[0], 'AI 模型消息'); // factory row 1 survived
  assert.equal(r.doc.interests[r.doc.interests.length - 1], '天文摄影');
  assert.equal((r.doc._schedule?.windows ?? []).length, 2); // factory schedule inherited
  // factory file untouched
  const factory = JSON.parse(fs.readFileSync(path.join(workspace().configDir, 'interests.json'), 'utf8')) as { interests: string[] };
  assert.equal(factory.interests.length, 14);
});

test('addInterest: trims, dedupes case-insensitively, rejects empty/overlong', () => {
  assert.equal(addInterest(guard, workspace(), '  AI 模型消息  ').ok, false); // factory dup
  assert.equal(addInterest(guard, workspace(), 'ai 模型消息').reason, 'duplicate');
  assert.equal(addInterest(guard, workspace(), '   ').reason, 'empty');
  assert.equal(addInterest(guard, workspace(), 'x'.repeat(61)).reason, 'too-long (max 60)');
  const r = addInterest(guard, workspace(), '  多   余   空格  ');
  assert.equal(r.ok, true);
  assert.ok(r.doc.interests.includes('多 余 空格'));
});

test('addInterest enforces the 32-row cap', () => {
  for (let i = 0; i < MAX_INTERESTS - 14; i += 1) {
    assert.equal(addInterest(guard, workspace(), `兴趣 ${i}`).ok, true);
  }
  assert.equal(addInterest(guard, workspace(), '第 33 条').reason, 'cap (32)');
});

test('removeInterest deletes only the named row; not-found creates nothing', () => {
  const miss = removeInterest(guard, workspace(), '不存在的兴趣');
  assert.equal(miss.ok, false);
  assert.equal(miss.reason, 'not-found');
  assert.equal(fs.existsSync(userInterestsPath(workspace())), false);
  const hit = removeInterest(guard, workspace(), '时政新闻');
  assert.equal(hit.ok, true);
  assert.equal(hit.doc.interests.length, 13);
  assert.ok(!hit.doc.interests.includes('时政新闻'));
});

test('setWanderWindows: full-state write preserves sibling _schedule keys', () => {
  const r = setWanderWindows(guard, workspace(), [
    { start: '09:00', end: '12:00' },
    { id: 'night', start: '20:30', end: '23:00' },
  ]);
  assert.equal(r.ok, true);
  const doc = ensureUserLayer(guard, workspace());
  assert.deepEqual(doc._schedule?.windows, [
    { id: '09:00-12:00', start: '09:00', end: '12:00' },
    { id: 'night', start: '20:30', end: '23:00' },
  ]);
  assert.equal(doc._schedule?.focus_cooldown_days, 3); // sibling key survived
  assert.equal(doc._schedule?.min_interval_hours, 4);
});

test('setWanderWindows rejects malformed, inverted, empty, overlapping, oversized sets', () => {
  const cases: [unknown, string][] = [
    [{ start: '9:00', end: '10:00' }, 'bad start "9:00"'],
    [{ start: '09:00', end: '25:00' }, 'bad end "25:00"'],
    [{ start: '10:00', end: '10:00' }, 'start 10:00 must be before end 10:00'],
    [{ start: '12:00', end: '09:00' }, 'start 12:00 must be before end 09:00'],
  ];
  for (const [w, reason] of cases) {
    assert.equal(setWanderWindows(guard, workspace(), [w]).reason, reason);
  }
  assert.equal(setWanderWindows(guard, workspace(), 'x').reason, 'windows-must-be-array');
  assert.equal(setWanderWindows(guard, workspace(), []).reason, 'at-least-one-window');
  assert.equal(
    setWanderWindows(guard, workspace(), [
      { start: '09:00', end: '12:00' },
      { start: '11:00', end: '13:00' },
    ]).reason,
    'windows overlap: 09:00-12:00 / 11:00-13:00',
  );
  // every failed case above stayed read-only
  assert.equal(fs.existsSync(userInterestsPath(workspace())), false);
  const six = Array.from({ length: 6 }, (_, i) => ({ start: `0${i}:00`, end: `0${i}:30` }));
  assert.equal(setWanderWindows(guard, workspace(), six).ok, true); // success -> layer created
  const seven = [...six, { start: '07:00', end: '07:30' }];
  assert.equal(setWanderWindows(guard, workspace(), seven).reason, 'cap (6)');
});

test('parseWindow + normalizeInterest unit behavior', () => {
  assert.deepEqual(parseWindow({ start: '11:00', end: '15:00' }), { ok: true, window: { id: '11:00-15:00', start: '11:00', end: '15:00' } });
  assert.equal(parseWindow(null).ok, false);
  assert.equal(normalizeInterest(' a  b\tc '), 'a b c');
});
