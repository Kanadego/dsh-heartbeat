// M7a status store tests (design doc §17.3 / §17.8):
// scene derivation matrix, store round-trip invariants, mtime-cached reader.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import {
  clampNote,
  deriveScene,
  readStatus,
  statusFilePath,
  StatusReader,
  writeStatus,
  type SceneInputs,
} from '../src/statusbar/store.js';

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-statusbar-'));
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  guard = createPathGuard(workspace().dataDir);
});

after(() => {
  resetWorkspaceForTest();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const base: SceneInputs = {
  quietHours: false,
  spokeThisBeat: false,
  wanderedThisBeat: false,
  presence: 'present',
};

test('deriveScene: priority matrix quiet-hours > just-spoke > wandering > busy > present > away', () => {
  assert.equal(deriveScene({ ...base, quietHours: true, spokeThisBeat: true, wanderedThisBeat: true, presence: 'active' }), 'quiet-hours');
  assert.equal(deriveScene({ ...base, spokeThisBeat: true, wanderedThisBeat: true, presence: 'active' }), 'just-spoke');
  assert.equal(deriveScene({ ...base, wanderedThisBeat: true, presence: 'active' }), 'wandering');
  assert.equal(deriveScene({ ...base, presence: 'active' }), 'busy');
  assert.equal(deriveScene({ ...base, presence: 'away' }), 'away');
  assert.equal(deriveScene({ ...base, presence: 'present' }), 'present');
});

test('deriveScene: unknown presence falls back to present', () => {
  assert.equal(deriveScene({ ...base, presence: 'unknown' }), 'present');
});

test('clampNote: trims, drops empty, enforces 30 chars', () => {
  assert.equal(clampNote(undefined), undefined);
  assert.equal(clampNote('   '), undefined);
  assert.equal(clampNote('  刚跟你说了句话  '), '刚跟你说了句话');
  assert.equal(clampNote('x'.repeat(31)), 'x'.repeat(30));
});

test('status store: write then read round-trips (plaintext, settings dir)', () => {
  const file = statusFilePath(workspace().dataDir);
  assert.equal(file, path.join(workspace().settingsDir, 'status.json'));
  writeStatus(guard, workspace(), { at: '2026-09-13T00:00:00.000Z', scene: 'just-spoke', note: '刚说了话' });
  assert.equal(readStatus(guard, workspace())?.scene, 'just-spoke');
  assert.equal(readStatus(guard, workspace())?.note, '刚说了话');
  // plaintext by design (D14 §10.5: scene enum carries no user-identifying content)
  assert.match(fs.readFileSync(file, 'utf8'), /"scene": "just-spoke"/);
});

test('status store: read returns null when missing or malformed', () => {
  assert.equal(readStatus(guard, workspace()), null);
  fs.mkdirSync(path.dirname(statusFilePath(workspace().dataDir)), { recursive: true });
  fs.writeFileSync(statusFilePath(workspace().dataDir), 'not json');
  assert.equal(readStatus(guard, workspace()), null);
});

test('StatusReader: caches by mtime and picks up rewrites', async () => {
  const reader = new StatusReader();
  assert.equal(reader.read(guard, workspace()), null);
  writeStatus(guard, workspace(), { at: '2026-09-13T00:00:00.000Z', scene: 'wandering' });
  assert.equal(reader.read(guard, workspace())?.scene, 'wandering');
  // same mtime window: subsequent reads hit the cache (no error, same value)
  assert.equal(reader.read(guard, workspace())?.scene, 'wandering');
  // force a change with a LATER mtime (fs may keep 1ms granularity on tmpfs)
  const file = statusFilePath(workspace().dataDir);
  const future = new Date(Date.now() + 2000);
  fs.utimesSync(file, future, future);
  writeStatus(guard, workspace(), { at: '2026-09-13T00:01:00.000Z', scene: 'busy' });
  assert.equal(reader.read(guard, workspace())?.scene, 'busy');
});

test('StatusReader: missing file after a known state clears the cache', () => {
  const reader = new StatusReader();
  writeStatus(guard, workspace(), { at: '2026-09-13T00:00:00.000Z', scene: 'away' });
  assert.equal(reader.read(guard, workspace())?.scene, 'away');
  fs.rmSync(statusFilePath(workspace().dataDir));
  assert.equal(reader.read(guard, workspace()), null);
});
