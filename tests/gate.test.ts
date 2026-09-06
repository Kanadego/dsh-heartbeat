import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import { loadPolicy } from '../src/config/load.js';
import type { Policy } from '../src/config/schema.js';
import { loadBusyRules, classifyProcess, classifyWindow } from '../src/gate/busy-rules.js';
import {
  evaluateGate,
  inQuietHours,
  readSentState,
  confirmSend,
  gateStatus,
} from '../src/gate/gate.js';

const NOON = Date.parse('2026-09-06T12:00:00.000+08:00'); // 12:00 local
const NIGHT = Date.parse('2026-09-06T02:00:00.000+08:00'); // inside quiet hours 01:00-08:00

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;
let policy: Policy;

function sentWith(count: number, lastTs: number) {
  return {
    today: '2026-09-06',
    items: Array.from({ length: count }, (_, i) => ({
      ts: lastTs,
      iso: new Date(lastTs).toISOString(),
      kind: 'topic',
      summary: `#${i}`,
    })),
  };
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-gate-'));
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  guard = createPathGuard(workspace().dataDir);
  policy = loadPolicy(guard, workspace().configDir, workspace().settingsDir);
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
});

const speak = (over: Partial<Parameters<typeof evaluateGate>[0]>) =>
  evaluateGate({
    now: NOON,
    policy,
    sent: sentWith(0, 0),
    presence: 'present',
    frontClass: 'idle',
    frontWhy: 'chrome',
    frontSource: 'live',
    ...over,
  } as never);

test('quiet hours silence everything', () => {
  const d = evaluateGate({
    now: NIGHT, policy, sent: sentWith(0, 0), presence: 'present',
    frontClass: 'idle', frontWhy: 'chrome', frontSource: 'live',
  });
  assert.equal(d.verdict, 'SILENT');
  assert.match(d.reason, /quiet hours/);
  assert.equal(inQuietHours(policy, NIGHT), true);
  assert.equal(inQuietHours(policy, NOON), false);
});

test('busy window class silences (live probe wins)', () => {
  const d = speak({ frontClass: 'busy', frontWhy: 'idea64' });
  assert.equal(d.verdict, 'SILENT');
  assert.match(d.reason, /busy window \(idea64\)/);
});

test('active presence (typing) silences', () => {
  const d = speak({ presence: 'active' });
  assert.equal(d.verdict, 'SILENT');
  assert.match(d.reason, /actively typing/);
});

test('daily cap silences', () => {
  const d = speak({ sent: sentWith(3, NOON - 3600_000) });
  assert.equal(d.verdict, 'SILENT');
  assert.match(d.reason, /daily cap/);
});

test('cooldown silences within 30 min of last send', () => {
  const d = speak({ sent: sentWith(1, NOON - 10 * 60_000) });
  assert.equal(d.verdict, 'SILENT');
  assert.match(d.reason, /cooldown 20min left/);
});

test('all clear -> SPEAK with window info', () => {
  const d = speak({});
  assert.equal(d.verdict, 'SPEAK');
  assert.equal(d.sentToday, 0);
  assert.equal(d.cap, 3);
  assert.equal(d.window.cls, 'idle');
});

test('sent state rolls over on a new day', () => {
  const yesterday = Date.parse('2026-09-05T12:00:00.000+08:00');
  const s = confirmSend(guard, policy, workspace(), 'topic', '昨天的话', yesterday);
  assert.equal(s.ok, true);
  // re-read "today" (2026-09-06): yesterday's items must not count
  const st = readSentState(guard, workspace(), NOON);
  assert.equal(st.items.length, 0);
  assert.equal(st.today, '2026-09-06');
});

test('confirmSend persists and gateStatus reflects it (encrypted at rest)', () => {
  const r = confirmSend(guard, policy, workspace(), 'topic', '今天的第一句', NOON);
  assert.equal(r.ok, true);
  const st = gateStatus(guard, policy, workspace(), NOON + 31 * 60_000);
  assert.equal(st.sent, 1);
  assert.equal(st.cap, 3);
  assert.equal(st.quiet, false);
  // sent.json must be DPAPI-encrypted
  const raw = fs.readFileSync(path.join(workspace().dataDir, 'sent.json'));
  assert.equal(raw.subarray(0, 5).toString('ascii'), 'KHBV1');
});

test('confirmSend refuses when cap is reached (fail-closed)', () => {
  const st = { today: '2026-09-06', items: sentWith(3, NOON - 3600_000).items };
  fs.writeFileSync(path.join(workspace().dataDir, 'sent.json'), JSON.stringify(st), 'utf8');
  const r = confirmSend(guard, policy, workspace(), 'topic', '超限', NOON);
  assert.equal(r.ok, false);
  assert.match(r.reason, /daily cap/);
});

test('busy-rules classification from the factory table', () => {
  const rules = loadBusyRules(workspace().configDir);
  assert.equal(classifyProcess('idea64', rules), 'busy');
  assert.equal(classifyProcess('chrome', rules), 'idle');
  assert.equal(classifyProcess('somegame', rules), 'unknown');
  // fullscreen game rule: unknown process covering the screen -> busy
  const full = classifyWindow(
    { process: 'somegame.exe', rect: { left: 0, top: 0, right: 1920, bottom: 1080 }, screen: [1920, 1080] },
    rules,
  );
  assert.equal(full.cls, 'busy');
  assert.match(full.why, /fullscreen/);
  // windowed game -> idle (v0.9 rule)
  const windowed = classifyWindow(
    { process: 'somegame.exe', rect: { left: 0, top: 0, right: 1600, bottom: 900 }, screen: [1920, 1080] },
    rules,
  );
  assert.equal(windowed.cls, 'idle');
  // idle-class fullscreen (video) stays idle
  const video = classifyWindow(
    { process: 'mpv', rect: { left: 0, top: 0, right: 1920, bottom: 1080 }, screen: [1920, 1080] },
    rules,
  );
  assert.equal(video.cls, 'idle');
});

test('presenceOf tiers (v0.9 rules)', async () => {
  const { presenceOf } = await import('../src/env/envpulse.js');
  assert.equal(presenceOf(-1, 'busy'), 'unknown');
  assert.equal(presenceOf(1500, 'busy'), 'away');
  assert.equal(presenceOf(60, 'busy'), 'present');
  assert.equal(presenceOf(5, 'busy'), 'active');
  assert.equal(presenceOf(5, 'idle'), 'present');
});
