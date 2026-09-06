import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFileSync, atomicWriteJsonSync, shredFileSync } from '../src/core/atomic-fs.js';

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-atomic-'));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('atomic write replaces existing content and leaves no temp files', () => {
  const file = path.join(dir, 'x.json');
  fs.writeFileSync(file, 'old');
  atomicWriteFileSync(file, 'new');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('atomic json write round-trips', () => {
  const file = path.join(dir, 'y.json');
  atomicWriteJsonSync(file, { a: 1, b: [2, 3] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1, b: [2, 3] });
});

test('shred removes the file after random overwrite passes', () => {
  const file = path.join(dir, 'secret.txt');
  fs.writeFileSync(file, 'plain-text-observation');
  shredFileSync(file, 2);
  assert.equal(fs.existsSync(file), false);
});

test('shred refuses directories', () => {
  assert.throws(() => shredFileSync(dir), /not a file/);
});
