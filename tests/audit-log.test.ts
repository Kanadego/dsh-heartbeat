import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendAuditLine, readAuditLines, pruneAuditFile } from '../src/core/audit-log.js';

let dir = '';
let file = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-audit-'));
  file = path.join(dir, 'heartbeat.jsonl');
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('append + read round-trips', () => {
  appendAuditLine(file, { event: 'spoke', reason: 'test' });
  appendAuditLine(file, { event: 'silent', reason: 'quiet hours' });
  const lines = readAuditLines<{ ts: string; event: string; reason: string }>(file);
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.event, 'spoke');
  assert.ok(lines[0]!.ts.length > 0);
});

test('corrupt lines are preserved as markers, not dropped', () => {
  fs.writeFileSync(file, '{"ts":"2026-01-01T00:00:00.000Z","event":"ok"}\n{broken\n', 'utf8');
  const lines = readAuditLines(file);
  assert.equal(lines.length, 2);
  assert.equal((lines[1] as unknown as { corrupt?: boolean }).corrupt, true);
});

test('prune removes only entries older than maxAgeMs', async () => {
  const old = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
  fs.writeFileSync(file, [
    JSON.stringify({ ts: old, event: 'ancient' }),
    JSON.stringify({ ts: new Date().toISOString(), event: 'fresh' }),
    '',
  ].join('\n'), 'utf8');
  const removed = pruneAuditFile(file, 30 * 24 * 3600 * 1000);
  assert.equal(removed, 1);
  const lines = readAuditLines<{ event: string }>(file);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.event, 'fresh');
});
