import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import {
  appendEntry,
  ledgerFilePath,
  markDone,
  pendingOlderThan,
  readLedger,
  scanPending,
} from '../src/ledger/ledger.js';

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;
let file = '';

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-ledger-'));
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  guard = createPathGuard(workspace().dataDir);
  file = ledgerFilePath(workspace().dataDir);
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
});

test('append creates the ledger with a header and one open entry', () => {
  const e = appendEntry(guard, file, '帮我看一下那个插件', Date.parse('2026-09-06T12:00:00'));
  assert.equal(e.status, 'open');
  assert.equal(e.date, '2026-09-06');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(raw.startsWith('# 账本'));
  assert.ok(raw.includes('[#') && raw.includes('[open]') && raw.includes('帮我看一下那个插件'));
});

test('scanPending returns only open entries, oldest first', () => {
  appendEntry(guard, file, '事项一', Date.parse('2026-09-01T10:00:00'));
  appendEntry(guard, file, '事项二', Date.parse('2026-09-05T10:00:00'));
  const first = scanPending(guard, file)[0]!;
  markDone(guard, file, first.id);
  const pending = scanPending(guard, file);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.text, '事项二');
});

test('markDone works by id and by unique substring, tolerant to hand edits', () => {
  const e = appendEntry(guard, file, '托付事项 alpha', Date.parse('2026-09-03T10:00:00'));
  assert.ok(markDone(guard, file, e.id));
  const e2 = appendEntry(guard, file, '托付事项 beta', Date.parse('2026-09-04T10:00:00'));
  assert.ok(markDone(guard, file, 'beta'));
  assert.equal(scanPending(guard, file).length, 0);
  // both entries present as done
  const { entries } = readLedger(guard, file);
  assert.equal(entries.filter((x) => x.status === 'done').length, 2);
  void e2;
});

test('markDone returns null for unknown keys', () => {
  appendEntry(guard, file, '某事项');
  assert.equal(markDone(guard, file, '不存在的关键词'), null);
});

test('hand-edited garbage lines are preserved verbatim on rewrite', () => {
  appendEntry(guard, file, '正常条目');
  const raw = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, raw + '这是用户手写的一行备注，格式随意\n', 'utf8');
  const e = appendEntry(guard, file, '追加条目');
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.includes('这是用户手写的一行备注，格式随意'));
  assert.ok(after.includes(e.id));
});

test('pendingOlderThan flags stale open items (跟进时机)', () => {
  appendEntry(guard, file, '很久之前的托付', Date.parse('2026-08-01T10:00:00'));
  appendEntry(guard, file, '今天的托付', Date.parse('2026-09-06T09:00:00'));
  const stale = pendingOlderThan(guard, file, 7, Date.parse('2026-09-06T12:00:00'));
  assert.equal(stale.length, 1);
  assert.equal(stale[0]!.text, '很久之前的托付');
});
