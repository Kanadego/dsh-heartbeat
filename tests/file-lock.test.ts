// HB-03 (2026-10-17 review): the cross-process lock used to be advisory in
// name only — after WAIT_MS it ran the callback anyway, and it judged staleness
// by mtime alone, so a live holder could have its lock deleted underneath it.
// These tests pin the fixed contract: no lock, no write.

import { sandboxDir } from './_sandbox.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FileLockTimeoutError, tryWithFileLock, withFileLock } from '../src/core/file-lock.js';

let sandbox = '';
let target = '';

/** A pid that is definitely not running (process.kill(pid, 0) throws ESRCH). */
function ghostPid(): number {
  let pid = 999_999;
  for (let i = 0; i < 50; i += 1) {
    try {
      process.kill(pid, 0);
      pid -= 1;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') return pid;
      pid -= 1;
    }
  }
  throw new Error('no unused pid found for the test');
}

function writeLock(lock: string, body: string, ageMs = 0): void {
  fs.writeFileSync(lock, body);
  if (ageMs > 0) {
    const old = (Date.now() - ageMs) / 1000;
    fs.utimesSync(lock, old, old);
  }
}

beforeEach(() => {
  sandbox = sandboxDir('hb-lock-');
  fs.mkdirSync(sandbox, { recursive: true });
  target = path.join(sandbox, 'thing.json');
});

after(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

test('withFileLock: fail-closed — a held lock means the write never happens', () => {
  const lock = `${target}.lock`;
  writeLock(lock, `${process.pid} ${new Date().toISOString()}\n`);
  let ran = false;
  assert.throws(() => withFileLock(target, () => { ran = true; }, { waitMs: 40 }), FileLockTimeoutError);
  assert.equal(ran, false);
  assert.equal(fs.existsSync(lock), true, 'the other holder keeps its lock');
});

test('tryWithFileLock: the same contention yields null instead of a write', () => {
  writeLock(`${target}.lock`, `${process.pid} ${new Date().toISOString()}\n`);
  let ran = false;
  const result = tryWithFileLock(target, () => { ran = true; return 'wrote'; }, { waitMs: 40 });
  assert.equal(result, null);
  assert.equal(ran, false);
});

test('withFileLock: the lock is released after the callback, including on throw', () => {
  assert.equal(withFileLock(target, () => 'ok'), 'ok');
  assert.equal(fs.existsSync(`${target}.lock`), false);
  assert.throws(() => withFileLock(target, () => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(`${target}.lock`), false, 'a throwing body still releases');
});

test('a stale lock whose holder died is reclaimed', () => {
  writeLock(`${target}.lock`, `${ghostPid()} 2020-01-01T00:00:00.000Z\n`, 60_000);
  assert.equal(withFileLock(target, () => 'reclaimed', { waitMs: 200 }), 'reclaimed');
});

test('a live holder is never robbed, however old the lock file is', () => {
  const lock = `${target}.lock`;
  writeLock(lock, `${process.pid} 2020-01-01T00:00:00.000Z\n`, 60_000);
  let ran = false;
  assert.throws(() => withFileLock(target, () => { ran = true; }, { waitMs: 40 }), FileLockTimeoutError);
  assert.equal(ran, false);
  assert.equal(fs.existsSync(lock), true);
});

test('an unidentifiable lock is only reclaimed once it is well past stale', () => {
  const lock = `${target}.lock`;
  writeLock(lock, 'not-a-pid\n', 60_000);
  assert.equal(withFileLock(target, () => 'reclaimed', { waitMs: 200 }), 'reclaimed');
  writeLock(lock, 'not-a-pid\n', 5_000);
  assert.throws(() => withFileLock(target, () => 'no', { waitMs: 40 }), FileLockTimeoutError);
});
