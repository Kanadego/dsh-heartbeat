import { sandboxDir } from './_sandbox.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync, atomicWriteJsonSync, shredFileSync } from '../src/core/atomic-fs.js';

let dir = '';

beforeEach(() => {
  dir = sandboxDir('hb-atomic-');
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

test('atomic write flushes before the rename (低优先级 review)', () => {
  const file = path.join(dir, 'flushed.json');
  let flushes = 0;
  const original = fs.fsyncSync;
  // The write path goes through the fs default export, so patching the property
  // is enough to observe the flush the crash-consistency fix added.
  (fs as unknown as { fsyncSync: typeof fs.fsyncSync }).fsyncSync = ((fd: number) => {
    flushes += 1;
    return original(fd);
  }) as typeof fs.fsyncSync;
  try {
    atomicWriteFileSync(file, JSON.stringify({ ok: true }));
  } finally {
    (fs as unknown as { fsyncSync: typeof fs.fsyncSync }).fsyncSync = original;
  }
  assert.ok(flushes >= 1, 'the payload must reach the disk before it is published');
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({ ok: true }));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), []);
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
