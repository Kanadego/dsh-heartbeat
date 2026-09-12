// M7c track tests (design doc §17.4–17.5, §17.7, D19/D21):
// capability probe, status text rendering (D21 red line), track memo audit,
// section text gating.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import {
  noteTrack,
  pinTrack,
  pinnedTrackFor,
  registerStatusbarSection,
  renderStatusText,
  resetCapabilityCache,
  resetPins,
  resetTrackMemo,
  supportsInHistory,
  trackFor,
} from '../src/statusbar/track.js';
import { StatusReader, readStatus, writeStatus } from '../src/statusbar/store.js';

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;
let auditFile = '';

const session = (id: string, events: { type: string; data?: unknown }[]): { id: string; seq?: number; snapshotEvents: () => { type: string; data?: unknown }[] } => ({
  id,
  snapshotEvents: () => events,
});

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-track-'));
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  guard = createPathGuard(workspace().dataDir);
  auditFile = path.join(workspace().logsDir, 'heartbeat.jsonl');
  resetCapabilityCache();
  resetTrackMemo();
  resetPins();
});

after(() => {
  resetWorkspaceForTest();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('supportsInHistory: reads the latest request/context route mode', () => {
  const capable = session('s-cap', [
    { type: 'request/context', data: { systemPromptUpdate: undefined } },
    { type: 'request/context', data: { systemPromptUpdate: 'in-history' } },
  ]);
  assert.equal(supportsInHistory(capable), true);
  const incapable = session('s-inc', [
    { type: 'request/context', data: { systemPromptUpdate: undefined } },
  ]);
  assert.equal(supportsInHistory(incapable), false);
});

test('supportsInHistory: no evidence yet defaults to Track B', () => {
  const fresh = session('s-fresh', [{ type: 'user/message' }]);
  assert.equal(trackFor(fresh), 'pre-step');
});

test('supportsInHistory: route change re-arms the cache via tail scan', () => {
  const events: { type: string; data?: unknown }[] = [{ type: 'request/context', data: { systemPromptUpdate: 'in-history' } }];
  const s = session('s-switch', events);
  assert.equal(supportsInHistory(s), true);
  events.push({ type: 'request/context', data: {} });
  (s as { seq?: number }).seq = 2;
  assert.equal(supportsInHistory(s), false);
});

test('supportsInHistory: incremental tail scan, no full rescans (琥珀 review #1)', () => {
  const events: { type: string; data?: unknown }[] = [{ type: 'request/context', data: { systemPromptUpdate: 'in-history' } }];
  const reads: number[] = [];
  const s = {
    id: 's-incr',
    snapshotEvents: (from?: number) => {
      reads.push(from ?? 0);
      return events.slice(from ?? 0);
    },
  };
  assert.equal(supportsInHistory(s), true); // initial full scan (from 0)
  // 50 noise events appended — no new request/context
  for (let i = 0; i < 50; i++) events.push({ type: 'step/end' });
  assert.equal(supportsInHistory(s), true);
  // the follow-up read was RANGED (watermark), not a full rescan
  assert.equal(reads[reads.length - 1], 1);
  // a new request/context in the tail still flips the verdict
  events.push({ type: 'request/context', data: {} });
  assert.equal(supportsInHistory(s), false);
});

test('renderStatusText: scene labels with optional note; zero time words (D21)', () => {
  assert.equal(renderStatusText(null), '');
  assert.match(renderStatusText({ at: 'x', scene: 'wandering' }), /心跳此刻：正在闲逛看新东西。$/);
  assert.match(renderStatusText({ at: 'x', scene: 'busy', note: '看到你在写代码' }), /不去打扰——看到你在写代码。$/);
  const text = renderStatusText({ at: 'x', scene: 'quiet-hours' });
  assert.doesNotMatch(text, /\d{1,2}:\d{2}/); // no clock-like tokens
  assert.doesNotMatch(text, /分钟|小时/);
});

test('noteTrack: audits only on track flips', () => {
  noteTrack(auditFile, 's1', 'pre-step');
  noteTrack(auditFile, 's1', 'pre-step'); // no flip → no line
  noteTrack(auditFile, 's1', 'system-prompt');
  const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { event: string; track: string });
  assert.equal(lines.filter((l) => l.event === 'statusbar_track').length, 2);
});

test('turn pin: mid-turn capability flip cannot split the turn (review #5)', () => {
  const events: { type: string; data?: unknown }[] = [{ type: 'user/message' }];
  const s = session('s-pin', events);
  // turn start, step===1: no evidence yet → pin Track B
  assert.equal(pinTrack('s-pin', s), 'pre-step');
  // the section reads the PIN, not the live probe → still Track B
  assert.equal(pinnedTrackFor('s-pin', s), 'pre-step');
  // step 1's request lands the in-history evidence mid-turn
  events.push({ type: 'request/context', data: { systemPromptUpdate: 'in-history' } });
  (s as { seq?: number }).seq = 2;
  assert.equal(trackFor(s), 'system-prompt'); // live probe HAS flipped…
  assert.equal(pinnedTrackFor('s-pin', s), 'pre-step'); // …but the pin holds for this turn
  // next turn start re-pins → the flip takes effect at the boundary
  assert.equal(pinTrack('s-pin', s), 'system-prompt');
  assert.equal(pinnedTrackFor('s-pin', s), 'system-prompt');
});

test('render purity: identical state renders byte-identical text (review #2)', () => {
  const state = { at: '2026-09-13T00:00:00.000Z', scene: 'wandering' as const, note: '刚搜到点新素材' };
  const a = renderStatusText(state);
  const b = renderStatusText(state);
  assert.equal(a, b);
  // and re-rendering after a store round-trip stays stable
  writeStatus(guard, workspace(), state);
  const c = renderStatusText(readStatus(guard, workspace()));
  assert.equal(c, a);
});

test('registerStatusbarSection: Track A renders scene only (no note, 琥珀 review #3); Track B renders empty', () => {
  const reader = new StatusReader();
  writeStatus(guard, workspace(), { at: 'x', scene: 'just-spoke', note: '刚跟你聊了两句' });
  let sectionDef: { text: (context: unknown) => string } | null = null;
  const ctx = {
    inject(_services: string[], cb: (scoped: unknown) => void) {
      cb({
        systemPrompt: { section(def: { name: string; order: number; text: (context: unknown) => string }) { sectionDef = def; return {}; } },
        effect(fn: () => unknown) { fn(); return undefined; },
        logger: { warn: () => {}, info: () => {}, error: () => {} },
      });
    },
  };
  registerStatusbarSection(ctx, guard, workspace(), { enabled: () => true, reader });
  assert.ok(sectionDef);
  const def = sectionDef as unknown as { name: string; order: number; text: (context: unknown) => string };
  assert.equal(def.name, 'heartbeat:status');
  assert.equal(def.order, 5000);
  // Track B session (no request/context evidence) → empty
  const fresh = { agent: { session: session('s-b', [{ type: 'user/message' }]) } };
  assert.equal(def.text(fresh), '');
  // Track A session (in-history evidence) → scene line WITHOUT the note
  const capable = { agent: { session: session('s-a', [{ type: 'request/context', data: { systemPromptUpdate: 'in-history' } }]) } };
  const rendered = def.text(capable);
  assert.match(rendered, /心跳此刻：刚去和你说过话。$/);
  assert.doesNotMatch(rendered, /刚跟你聊了两句/);
  // disabled → empty even on Track A sessions
  const ctxOff = {
    inject(_services: string[], cb: (scoped: unknown) => void) {
      cb({
        systemPrompt: { section(def2: { text: (context: unknown) => string }) { sectionDef = def2 as never; return {}; } },
        effect(fn: () => unknown) { fn(); return undefined; },
        logger: { warn: () => {}, info: () => {}, error: () => {} },
      });
    },
  };
  resetCapabilityCache();
  resetTrackMemo();
  registerStatusbarSection(ctxOff, guard, workspace(), { enabled: () => false, reader });
  assert.equal((sectionDef as unknown as { text: (context: unknown) => string }).text(capable), '');
});
