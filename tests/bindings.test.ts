// H-85: the bindings store had no test file of its own. It is the authority
// for "which sessions does the beat observe / speak into", edited from three
// sides (CLI, RPC card, hand), so its merge semantics deserve cover.

import { sandboxDir } from './_sandbox.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import {
  addBinding,
  bindingsFilePath,
  deliverTargets,
  loadBindings,
  observeTargets,
  removeBinding,
  saveBindings,
} from '../src/core/bindings.js';

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;
let settingsDir = '';

const read = () => JSON.parse(fs.readFileSync(bindingsFilePath(settingsDir), 'utf8')) as {
  bindings: { sessionId: string; deliver: boolean; observe: boolean; addedAt: string }[];
};

beforeEach(() => {
  sandbox = sandboxDir('hb-bind-');
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  guard = createPathGuard(workspace().dataDir);
  settingsDir = workspace().settingsDir;
});

after(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

test('loadBindings: a missing file is an empty list, never a throw', () => {
  assert.deepEqual(loadBindings(guard, settingsDir), { bindings: [] });
});

test('loadBindings: corrupt JSON and a missing field both degrade to empty', () => {
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(bindingsFilePath(settingsDir), '{ not json', 'utf8');
  assert.deepEqual(loadBindings(guard, settingsDir), { bindings: [] });

  fs.writeFileSync(bindingsFilePath(settingsDir), JSON.stringify({ nope: 1 }), 'utf8');
  assert.deepEqual(loadBindings(guard, settingsDir), { bindings: [] });
});

test('addBinding: deliver defaults on, observe defaults off, addedAt is ISO', () => {
  const b = addBinding(guard, settingsDir, 'session-a');
  assert.equal(b.deliver, true);
  assert.equal(b.observe, false);
  assert.match(b.addedAt, /^\d{4}-\d{2}-\d{2}T/);

  const saved = read();
  assert.equal(saved.bindings.length, 1);
  assert.equal(saved.bindings[0]!.sessionId, 'session-a');
});

test('addBinding: explicit flags win, and the file is written with indentation', () => {
  addBinding(guard, settingsDir, 'session-b', { deliver: false, observe: true });
  const raw = fs.readFileSync(bindingsFilePath(settingsDir), 'utf8');
  assert.match(raw, /\n {2}"bindings"/, 'pretty-printed JSON');
  const b = read().bindings[0]!;
  assert.equal(b.deliver, false);
  assert.equal(b.observe, true);
});

test('addBinding: a repeat id updates in place instead of appending a duplicate', () => {
  const first = addBinding(guard, settingsDir, 'session-a', { observe: false });
  const again = addBinding(guard, settingsDir, 'session-a', { observe: true });

  assert.equal(read().bindings.length, 1, 'still one binding');
  assert.equal(again.observe, true);
  assert.equal(again.addedAt, first.addedAt, 'the original addedAt survives');
  assert.equal(again.deliver, true, 'an unspecified flag keeps its old value');
});

test('addBinding: a partial update leaves the other flag alone', () => {
  addBinding(guard, settingsDir, 'session-a', { deliver: false, observe: true });
  const updated = addBinding(guard, settingsDir, 'session-a', { deliver: true });
  assert.equal(updated.deliver, true);
  assert.equal(updated.observe, true, 'observe was not mentioned, so it stays');
});

test('removeBinding: reports whether anything was removed, and persists', () => {
  addBinding(guard, settingsDir, 'session-a');
  addBinding(guard, settingsDir, 'session-b');

  assert.equal(removeBinding(guard, settingsDir, 'session-missing'), false);
  assert.equal(read().bindings.length, 2, 'a miss must not rewrite the file');

  assert.equal(removeBinding(guard, settingsDir, 'session-a'), true);
  const left = read().bindings;
  assert.equal(left.length, 1);
  assert.equal(left[0]!.sessionId, 'session-b');
});

test('deliverTargets / observeTargets: independent filters over one list', () => {
  addBinding(guard, settingsDir, 'session-deliver', { deliver: true, observe: false });
  addBinding(guard, settingsDir, 'session-observe', { deliver: false, observe: true });
  addBinding(guard, settingsDir, 'session-both', { deliver: true, observe: true });

  const data = loadBindings(guard, settingsDir);
  const ids = (list: { sessionId: string }[]) => list.map((b) => b.sessionId).sort();
  assert.deepEqual(ids(deliverTargets(data)), ['session-both', 'session-deliver']);
  assert.deepEqual(ids(observeTargets(data)), ['session-both', 'session-observe']);
});

test('saveBindings: writes atomically and creates the settings dir when missing', () => {
  const deep = path.join(workspace().dataDir, 'fresh', 'settings');
  saveBindings(guard, deep, { bindings: [] });
  assert.equal(JSON.parse(fs.readFileSync(path.join(deep, 'bindings.json'), 'utf8')).bindings.length, 0);
  // no temp sibling left behind by the atomic write
  const leftovers = fs.readdirSync(deep).filter((f) => f !== 'bindings.json');
  assert.deepEqual(leftovers, [], 'the tmp file must be renamed away');
});
