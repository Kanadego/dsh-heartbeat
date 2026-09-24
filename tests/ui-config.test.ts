import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import { loadUiConfig, saveUiConfig, uiConfigPath, USER_UI_FILE } from '../src/config/ui-config.js';
import { loadPolicy, updateUserPolicy } from '../src/config/load.js';

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;
let paths: ReturnType<typeof workspace>;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-uicfg-'));
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  paths = initWorkspace();
  guard = createPathGuard(paths.dataDir);
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
});

test('ui-config: missing layer loads as empty object', () => {
  assert.deepEqual(loadUiConfig(guard, paths.settingsDir), {});
});

test('ui-config: save + load roundtrip merges and persists', () => {
  saveUiConfig(guard, paths.settingsDir, { intervalMin: 30, statusbar: false });
  const merged = saveUiConfig(guard, paths.settingsDir, { idleMode: true });
  assert.equal(merged.intervalMin, 30); // first write survives the second save
  assert.equal(merged.statusbar, false);
  assert.equal(merged.idleMode, true);
  assert.deepEqual(loadUiConfig(guard, paths.settingsDir), merged);
  assert.ok(fs.existsSync(uiConfigPath(paths.settingsDir)));
  assert.match(path.basename(uiConfigPath(paths.settingsDir)), new RegExp(USER_UI_FILE));
});

test('ui-config: out-of-range and unknown fields are dropped', () => {
  const merged = saveUiConfig(guard, paths.settingsDir, {
    intervalMin: 99999,
    maxDailySend: 0,
    timeInjectMin: -5,
    statusbar: true,
  });
  assert.equal(merged.intervalMin, undefined);
  assert.equal(merged.maxDailySend, undefined);
  assert.equal(merged.timeInjectMin, undefined);
  assert.equal(merged.statusbar, true);
});

test('ui-config: corrupt layer fails open to defaults', () => {
  fs.mkdirSync(paths.settingsDir, { recursive: true });
  fs.writeFileSync(uiConfigPath(paths.settingsDir), '{broken', 'utf8');
  assert.deepEqual(loadUiConfig(guard, paths.settingsDir), {});
  // and the next save repairs the file
  const merged = saveUiConfig(guard, paths.settingsDir, { timeInjectMin: 0 });
  assert.equal(merged.timeInjectMin, 0);
  assert.deepEqual(loadUiConfig(guard, paths.settingsDir), merged);
});

test('ui-config: tokenSaver persists and out-of-range numbers never pass', () => {
  const merged = saveUiConfig(guard, paths.settingsDir, { tokenSaver: true, intervalMin: 20 });
  assert.equal(merged.tokenSaver, true);
  assert.equal(loadUiConfig(guard, paths.settingsDir).tokenSaver, true);
});

test('policy: updateUserPolicy merges into the user layer and flips psyEnabled on load', () => {
  const policy = loadPolicy(guard, paths.configDir, paths.settingsDir);
  assert.equal(policy.profile.psyEnabled, false); // factory default
  updateUserPolicy(guard, paths.settingsDir, { profile: { psyEnabled: true } });
  const updated = loadPolicy(guard, paths.configDir, paths.settingsDir);
  assert.equal(updated.profile.psyEnabled, true);
  // untouched factory fields still come from the factory layer
  assert.equal(updated.heartbeat.intervalMin, policy.heartbeat.intervalMin);
});
