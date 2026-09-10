import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BUNDLED_PRESET_ID,
  COMPOSITION_FILE,
  METADATA_FILE,
  bundledPresetDir,
  conventionalUserPresetRoot,
  installBundledPreset,
  presetStatus,
  userPresetRoot,
} from '../src/core/preset-install.js';

// The suite runs from the repo, so walking up from this module URL finds
// <repo>/assets/presets/heartbeat — the same layout an installed package has.
const moduleUrl = import.meta.url;
let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-preset-'));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('the bundled template is found by walking up from a module URL', () => {
  const dir = bundledPresetDir(moduleUrl);
  assert.ok(dir, 'expected assets/presets/heartbeat beside the package');
  assert.ok(fs.existsSync(path.join(dir, COMPOSITION_FILE)));
  assert.ok(fs.existsSync(path.join(dir, METADATA_FILE)));
});

test('install creates the preset, then reports exists', () => {
  const first = installBundledPreset({ moduleUrl, root });
  assert.equal(first.action, 'created');
  const dir = path.join(root, BUNDLED_PRESET_ID);
  assert.ok(fs.existsSync(path.join(dir, COMPOSITION_FILE)));
  assert.ok(fs.existsSync(path.join(dir, METADATA_FILE)));
  // byte-identical to the shipped template
  const bundled = bundledPresetDir(moduleUrl) as string;
  assert.ok(
    fs.readFileSync(path.join(dir, COMPOSITION_FILE)).equals(fs.readFileSync(path.join(bundled, COMPOSITION_FILE))),
  );
  assert.equal(installBundledPreset({ moduleUrl, root }).action, 'exists');
});

test('a hand-edited preset is never overwritten unless forced', () => {
  installBundledPreset({ moduleUrl, root });
  const composition = path.join(root, BUNDLED_PRESET_ID, COMPOSITION_FILE);
  fs.writeFileSync(composition, '# mine\n');
  const kept = installBundledPreset({ moduleUrl, root });
  assert.equal(kept.action, 'exists');
  assert.match(String(kept.detail), /differs/);
  assert.equal(fs.readFileSync(composition, 'utf8'), '# mine\n');
  assert.equal(installBundledPreset({ moduleUrl, root, force: true }).action, 'restored');
  assert.notEqual(fs.readFileSync(composition, 'utf8'), '# mine\n');
});

test('a directory without a composition file is repaired', () => {
  fs.mkdirSync(path.join(root, BUNDLED_PRESET_ID), { recursive: true });
  assert.equal(installBundledPreset({ moduleUrl, root }).action, 'repaired');
});

test('skips when disabled, when the id is not the bundled one, or without a user root', () => {
  assert.equal(installBundledPreset({ moduleUrl, root, enabled: false }).action, 'skipped-disabled');
  assert.equal(installBundledPreset({ moduleUrl, root, id: 'mine' }).action, 'skipped-custom-id');
  assert.equal(
    installBundledPreset({ moduleUrl, root: undefined, rosterKnown: true }).action,
    'skipped-no-root',
  );
});

test('userPresetRoot picks the user-trust root only', () => {
  assert.equal(
    userPresetRoot([{ path: 'C:/shipped', trust: 'system' }, { path: root, trust: 'user' }]),
    path.resolve(root),
  );
  assert.equal(userPresetRoot([{ path: 'C:/shipped', trust: 'system' }]), undefined);
  assert.equal(userPresetRoot(undefined), undefined);
});

test('conventionalUserPresetRoot honours $DSH_HOME over the default home', () => {
  assert.equal(
    conventionalUserPresetRoot({ DSH_HOME: 'C:/custom' } as NodeJS.ProcessEnv, 'C:/home'),
    path.join('C:/custom', '.agent-presets'),
  );
  assert.equal(
    conventionalUserPresetRoot({} as NodeJS.ProcessEnv, 'C:/home'),
    path.join('C:/home', '.dsh', '.agent-presets'),
  );
  assert.equal(
    conventionalUserPresetRoot({ DSH_HOME: '   ' } as NodeJS.ProcessEnv, 'C:/home'),
    path.join('C:/home', '.dsh', '.agent-presets'),
  );
});

test('presetStatus reports install state and template match', () => {
  assert.equal(presetStatus(moduleUrl, BUNDLED_PRESET_ID, root).installed, false);
  installBundledPreset({ moduleUrl, root });
  const status = presetStatus(moduleUrl, BUNDLED_PRESET_ID, root);
  assert.equal(status.installed, true);
  assert.equal(status.compositionMatches, true);
  assert.equal(status.metadataMatches, true);
  fs.writeFileSync(path.join(root, BUNDLED_PRESET_ID, COMPOSITION_FILE), '# other\n');
  const drifted = presetStatus(moduleUrl, BUNDLED_PRESET_ID, root);
  assert.equal(drifted.installed, true);
  assert.equal(drifted.compositionMatches, false);
});
