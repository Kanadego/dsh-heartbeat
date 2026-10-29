// v2.1.0 focus mode: the runtime pause.
//
// Covers the pause state machine (pauseFocus/resumeFocus/focusPendingAt), the
// cross-process half (data/focus.json — what the operational CLI actually
// writes), the status-note formatting, and the beat entry gate: a beat that
// starts while the pause holds must leave exactly one `silent` audit line,
// write the "专注模式" status, and touch neither the agent factory nor the beat
// ordinal.

import { sandboxDir } from './_sandbox.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import { readAuditLines } from '../src/core/audit-log.js';
import { readStatus } from '../src/statusbar/store.js';
import {
  beat,
  focusPendingAt,
  formatFocusClock,
  formatFocusNote,
  getFocusUntil,
  pauseFocus,
  resumeFocus,
  type OrchestratorDeps,
} from '../src/core/orchestrator.js';
import { clearFocusState, focusStatePath, readFocusState, writeFocusState } from '../src/core/focus-store.js';

const MIN = 60_000;

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;

beforeEach(() => {
  sandbox = sandboxDir('hb-focus-');
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  guard = createPathGuard(workspace().dataDir);
  resumeFocus(); // module state must not leak between cases
});

after(() => {
  resumeFocus();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

function auditFile(): string {
  return path.join(workspace().logsDir, 'heartbeat.jsonl');
}

/** Minimal deps for the focus-gate path: it must never reach agent
 *  acquisition, so the factory here is a tripwire. */
function makeDeps(): { deps: OrchestratorDeps; created: () => number } {
  let created = 0;
  const ctx = {
    agents: {
      create: () => {
        created += 1;
        throw new Error('focus mode must not acquire an agent');
      },
      resume: () => {
        throw new Error('focus mode must not resume an agent');
      },
      roots: () => [],
      get: () => undefined,
    },
    logger: { info() {}, warn() {}, error() {} },
    effect: () => () => {},
  };
  return {
    deps: { ctx, paths: workspace(), guard, policy: {} } as unknown as OrchestratorDeps,
    created: () => created,
  };
}

// ── pause state machine ──────────────────────────────────────────────────

test('pauseFocus sets a future instant and getFocusUntil reports it', () => {
  const before = Date.now();
  const until = pauseFocus(30);
  assert.ok(until >= before + 30 * MIN - 50 && until <= Date.now() + 30 * MIN + 50);
  assert.equal(getFocusUntil(), until);
  resumeFocus();
  assert.equal(getFocusUntil(), 0);
});

test('pauseFocus clamps to [1, 1440] minutes and floors fractions', () => {
  assert.ok(pauseFocus(0) <= Date.now() + 1 * MIN + 50);
  resumeFocus();
  assert.ok(pauseFocus(-10) <= Date.now() + 1 * MIN + 50);
  resumeFocus();
  assert.ok(pauseFocus(999_999) >= Date.now() + 1440 * MIN - 50);
  resumeFocus();
  const t = pauseFocus(29.9);
  assert.ok(t >= Date.now() + 29 * MIN - 50 && t <= Date.now() + 30 * MIN);
  resumeFocus();
});

test('focusPendingAt: 0 before, the instant during, 0 after expiry', () => {
  assert.equal(focusPendingAt(Date.now()), 0);
  const until = pauseFocus(5);
  assert.equal(focusPendingAt(until - 1), until);
  assert.equal(focusPendingAt(until), 0);
  resumeFocus();
  assert.equal(focusPendingAt(Date.now()), 0);
});

// ── status note (≤30-char store invariant) ───────────────────────────────

test('formatFocusClock renders local HH:MM', () => {
  // Month is 0-based: 2026-10-29 14:05 local wall clock.
  assert.equal(formatFocusClock(new Date(2026, 9, 29, 14, 5).getTime()), '14:05');
  assert.equal(formatFocusClock(new Date(2026, 9, 29, 3, 42).getTime()), '03:42');
});

test('formatFocusNote names the mode and the lift time', () => {
  const until = new Date(2026, 9, 29, 22, 30).getTime();
  const note = formatFocusNote(until);
  assert.match(note, /^专注模式 · 至 \d{2}:\d{2}$/);
  assert.ok(note.length <= 30);
  assert.equal(note, '专注模式 · 至 22:30');
});

// ── beat entry gate ──────────────────────────────────────────────────────

test('beat during the pause: one silent line, focus status, no agent, no beat ordinal', async () => {
  const { deps, created } = makeDeps();
  const until = pauseFocus(5);
  await beat(deps, 'interval');

  const lines = readAuditLines<{ event: string; reason?: string; until?: string }>(auditFile());
  const silent = lines.filter((l) => l.event === 'silent' && l.reason === 'focus-mode');
  assert.equal(silent.length, 1);
  assert.equal(silent[0]!.until, new Date(until).toISOString());
  // The gate sits before everything a real beat does — no beat_start, no
  // notepad ordinal (no notepad write), no agent acquisition attempt.
  assert.equal(lines.some((l) => l.event === 'beat_start'), false);
  assert.equal(created(), 0);

  const status = readStatus(guard, workspace());
  assert.ok(status);
  assert.equal(status.scene, 'away');
  assert.equal(status.note, formatFocusNote(until));
});

// A full beat AFTER resumeFocus is deliberately not exercised here: past the
// gate it runs the real agentless path (maintenance/collect subprocesses plus
// the deferred-retry timer), which belongs to orchestrator.test.ts's scope.
// The resume semantics are covered by the focusPendingAt case above: 0 after
// resumeFocus() means beat() falls straight through the gate.

// ── cross-process half: data/focus.json ──────────────────────────────────
//
// The operational CLI runs in its own process, so `heartbeat focus 30` can
// only reach the host through the file. Without this, the command silently
// pauses a module variable nobody reads (the v2.1.0 review caught exactly
// that). These cases pin the file contract from the host side.

test('a file-only pause silences the beat without pauseFocus()', async () => {
  const { deps, created } = makeDeps();
  const until = writeFocusState(guard, workspace(), 10, Date.now(), 'cli').until;
  assert.equal(getFocusUntil(), 0); // module state untouched — the pure CLI path

  await beat(deps, 'interval');

  const lines = readAuditLines<{ event: string; reason?: string; until?: string }>(auditFile());
  const silent = lines.filter((l) => l.event === 'silent' && l.reason === 'focus-mode');
  assert.equal(silent.length, 1);
  assert.equal(silent[0]!.until, new Date(until).toISOString());
  assert.equal(created(), 0);
  const status = readStatus(guard, workspace());
  assert.ok(status);
  assert.equal(status.note, formatFocusNote(until));
});

test('an in-memory pause and a later file pause both hold (max wins)', async () => {
  const { deps, created } = makeDeps();
  // File says 5 min, memory says 30 min: the later lift time must win, or the
  // shorter file record would cut an in-session pause short.
  const fileUntil = writeFocusState(guard, workspace(), 5, Date.now(), 'cli').until;
  const memUntil = pauseFocus(30);
  assert.ok(memUntil > fileUntil);

  await beat(deps, 'interval');

  const lines = readAuditLines<{ event: string; reason?: string; until?: string }>(auditFile());
  const silent = lines.filter((l) => l.event === 'silent' && l.reason === 'focus-mode');
  assert.equal(silent.length, 1);
  assert.equal(silent[0]!.until, new Date(memUntil).toISOString());
  assert.equal(created(), 0);
});

test('readFocusState drops an expired record; clearFocusState removes the file', () => {
  // Written 10 minutes ago for 5 minutes: stale on read, still on disk.
  writeFocusState(guard, workspace(), 5, Date.now() - 10 * MIN, 'cli');
  assert.equal(readFocusState(guard, workspace()), null);
  assert.ok(fs.existsSync(focusStatePath(workspace())));

  writeFocusState(guard, workspace(), 5, Date.now(), 'cli');
  assert.ok(readFocusState(guard, workspace()));
  assert.equal(clearFocusState(guard, workspace()), true);
  assert.equal(fs.existsSync(focusStatePath(workspace())), false);
  assert.equal(clearFocusState(guard, workspace()), false);
});
