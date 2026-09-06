import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPathGuard, canonicalize, isInsideWorkspace } from '../src/core/path-guard.js';

let sandbox = '';
let outside = '';

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-guard-ws-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-guard-out-'));
  fs.mkdirSync(path.join(sandbox, 'data', 'logs'), { recursive: true });
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('accepts paths inside the workspace', () => {
  const guard = createPathGuard(path.join(sandbox, 'data'));
  const got = guard.assert(path.join(sandbox, 'data', 'seeds.json'));
  assert.ok(got.toLowerCase().includes('seeds.json'));
});

test('accepts a planned (nonexistent) file under the workspace', () => {
  const guard = createPathGuard(path.join(sandbox, 'data'));
  const got = guard.assert(path.join(sandbox, 'data', 'logs', 'future.jsonl'));
  assert.ok(got.toLowerCase().includes(path.join('logs', 'future.jsonl')));
});

test('rejects .. traversal that escapes the workspace', () => {
  const guard = createPathGuard(path.join(sandbox, 'data'));
  const evil = path.join(sandbox, 'data', '..', '..', '..', 'Windows', 'system32', 'config');
  assert.throws(() => guard.assert(evil), /outside workspace/);
});

test('rejects a junction inside the workspace pointing outside', () => {
  const guard = createPathGuard(path.join(sandbox, 'data'));
  const link = path.join(sandbox, 'data', 'escape');
  fs.symlinkSync(outside, link, 'junction');
  assert.throws(() => guard.assert(path.join(link, 'secret.txt')), /outside workspace/);
});

test('rejects a same-drive path outside the workspace tree', () => {
  const guard = createPathGuard(path.join(sandbox, 'data'));
  const sameDriveOutside = path.join(path.parse(sandbox).root, 'hb-guard-should-not-exist', 'x.txt');
  assert.throws(() => guard.assert(sameDriveOutside), /outside workspace/);
});

test('accepts case variants of workspace paths (Windows case-insensitive)', () => {
  const guard = createPathGuard(path.join(sandbox, 'data'));
  const lower = guard.assert(path.join(sandbox, 'data', 'x.json'));
  const upper = guard.assert(path.join(sandbox, 'DATA', 'x.json'));
  assert.equal(lower.toLowerCase(), upper.toLowerCase());
});

test('workspace dir itself is inside the boundary', () => {
  const guard = createPathGuard(path.join(sandbox, 'data'));
  assert.equal(guard.assert(path.join(sandbox, 'data')), guard.workspace);
});

test('check() returns null instead of throwing', () => {
  const guard = createPathGuard(path.join(sandbox, 'data'));
  assert.equal(guard.check(path.join(sandbox, 'other.txt')), null);
  assert.ok(guard.check(path.join(sandbox, 'data', 'ok.txt')));
});

test('prefix boundary: sibling dir with matching prefix does not pass', () => {
  // data-evil is a sibling of data, shares the prefix "data"
  const dataDir = path.join(sandbox, 'data');
  fs.mkdirSync(dataDir + '-evil', { recursive: true });
  const guard = createPathGuard(dataDir);
  assert.equal(isInsideWorkspace(guard.workspace, canonicalize(dataDir + '-evil')), false);
});
