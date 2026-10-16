// HB-15 (2026-10-17 review): a screenshot on disk used to be treated as the
// current screen just because the file existed - a failed collection left last
// beat's picture in place and vision described it as "now". Option B (the
// user's call): with a failed collection the beat loses its picture, and the
// stale image is burnt. The stamp ties image and screen.json to one captured_at.

import { sandboxDir } from './_sandbox.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import { encryptFile, resetVaultKeyCacheForTest, saveJson } from '../src/vault/vault.js';
import {
  burnUnlocked,
  dropStaleShot,
  readScreenStamp,
  screenJpgPath,
  screenJsonPath,
  screenStampPath,
  shotIsCurrent,
  unlockShot,
} from '../src/screen/screenpulse.js';

const AT = '2026-10-17T05:41:00.000Z';
const OTHER = '2026-10-17T05:11:00.000Z';
const JPG = Buffer.from('pretend-this-is-a-jpeg-payload', 'utf8');

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;

beforeEach(() => {
  sandbox = sandboxDir('hb-shot-');
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  resetVaultKeyCacheForTest();
  guard = createPathGuard(workspace().dataDir);
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
  resetVaultKeyCacheForTest();
});

/** Lay down an encrypted shot + snapshot; stamp === null leaves no stamp. */
function writeShot(capturedAt: string, stamp: string | null): void {
  const paths = workspace();
  const plain = path.join(paths.tmpDir, `shot-src-${Math.random().toString(36).slice(2)}.jpg`);
  fs.writeFileSync(plain, JPG);
  encryptFile(guard, plain, screenJpgPath(paths));
  fs.rmSync(plain, { force: true });
  saveJson(guard, screenJsonPath(paths), {
    title: 'T',
    process: 'p',
    pid: 1,
    rect: null,
    screen: null,
    focus: { title: 'T', process: 'p', pid: 1 },
    windows: [],
    captured_at: capturedAt,
  });
  if (stamp !== null) fs.writeFileSync(screenStampPath(paths), stamp, 'utf8');
}

test('HB-15: a shot whose stamp matches screen.json unlocks, and burns after use', () => {
  const paths = workspace();
  writeShot(AT, AT);
  assert.equal(readScreenStamp(paths), AT);
  assert.equal(shotIsCurrent(guard, paths), true);
  const view = unlockShot(guard, paths);
  assert.ok(view, 'the current shot is unlocked');
  assert.deepEqual(fs.readFileSync(view as string), JPG);
  burnUnlocked(guard, view as string);
  assert.equal(fs.existsSync(view as string), false, 'the plaintext view is burnt');
});

test('HB-15: a leftover shot from an earlier beat is refused', () => {
  const paths = workspace();
  writeShot(AT, OTHER);
  assert.equal(shotIsCurrent(guard, paths), false);
  assert.equal(unlockShot(guard, paths), null);
});

test('HB-15: a shot with no stamp at all is refused', () => {
  const paths = workspace();
  writeShot(AT, null);
  assert.equal(shotIsCurrent(guard, paths), false);
  assert.equal(unlockShot(guard, paths), null);
});

test('HB-15: a stamp without a snapshot is refused', () => {
  const paths = workspace();
  writeShot(AT, AT);
  fs.rmSync(screenJsonPath(paths), { force: true });
  assert.equal(shotIsCurrent(guard, paths), false);
  assert.equal(unlockShot(guard, paths), null);
});

test('HB-15 (B): dropStaleShot burns the image and its stamp', () => {
  const paths = workspace();
  writeShot(AT, AT);
  assert.equal(fs.existsSync(screenJpgPath(paths)), true);
  dropStaleShot(guard, paths);
  assert.equal(fs.existsSync(screenJpgPath(paths)), false, 'the stale image is gone');
  assert.equal(readScreenStamp(paths), '', 'its stamp is gone too');
  assert.equal(shotIsCurrent(guard, paths), false);
});
