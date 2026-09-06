import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writePulseStream, type EnvSnapshot } from '../src/env/envpulse.js';
import { readAuditLines, pruneAuditFile } from '../src/core/audit-log.js';

// §12 #3: the raw pulse stream (logs/envpulse.jsonl) appends one line per
// beat and is pruned by envPulseHours. writePulseStream is a pure side effect
// (no PowerShell spawn), so this test needs no real environment.

let dir = '';
let paths: { logsDir: string; dataDir: string };

const snapshot: EnvSnapshot = {
  takenAt: '2026-09-06T10:00:00.000Z',
  idleSeconds: 42,
  presence: 'present',
  windowClass: 'idle',
  daypart: 'morning',
  weekday: 'Sunday',
  isWeekend: true,
  festival: null,
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-envpulse-'));
  paths = { logsDir: path.join(dir, 'logs'), dataDir: dir };
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writePulseStream appends one JSONL line with all aggregate fields', () => {
  writePulseStream(paths as never, snapshot);
  const lines = readAuditLines<{ event: string; takenAt: string; idleSeconds: number; windowClass: string }>(
    path.join(paths.logsDir, 'envpulse.jsonl'),
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.event, 'pulse');
  assert.equal(lines[0]!.takenAt, snapshot.takenAt);
  assert.equal(lines[0]!.idleSeconds, 42);
  assert.equal(lines[0]!.windowClass, 'idle');
});

test('writePulseStream appends (never overwrites) across beats', () => {
  writePulseStream(paths as never, snapshot);
  writePulseStream(paths as never, { ...snapshot, takenAt: '2026-09-06T12:00:00.000Z', idleSeconds: 999 });
  const lines = readAuditLines<{ idleSeconds: number; takenAt: string }>(
    path.join(paths.logsDir, 'envpulse.jsonl'),
  );
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.idleSeconds, 42);
  assert.equal(lines[1]!.idleSeconds, 999);
});

test('stream lines are prunable by envPulseHours through the shared audit path', () => {
  const old = new Date(Date.now() - 100 * 3600 * 1000).toISOString();
  const file = path.join(paths.logsDir, 'envpulse.jsonl');
  fs.mkdirSync(paths.logsDir, { recursive: true });
  fs.writeFileSync(file, [
    JSON.stringify({ ts: old, event: 'pulse', takenAt: old, idleSeconds: 1 }),
    JSON.stringify({ ts: new Date().toISOString(), event: 'pulse', takenAt: new Date().toISOString(), idleSeconds: 2 }),
    '',
  ].join('\n'), 'utf8');
  const removed = pruneAuditFile(file, 48 * 3600 * 1000);
  assert.equal(removed, 1);
  const lines = readAuditLines<{ idleSeconds: number }>(file);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.idleSeconds, 2);
});