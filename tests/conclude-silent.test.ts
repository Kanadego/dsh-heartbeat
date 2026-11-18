// 2.3.0 experimental concludeSilentTurn: when a silent report has LANDED and
// the switch is on, the tool calls the host's exec.concludeTurn() so the turn
// ends with zero body text. Off by default; material/heartfelt never conclude;
// a host without concludeTurn must not throw.
// DPAPI vault shells out per read/write, so tests batch whole files.
import { sandboxDir } from './_sandbox.js';
import { test, beforeEach, after } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard, type PathGuard } from '../src/core/path-guard.js';
import { buildSeedReportTool, readSeedReports, reportFilePath, markConcludeRequested, resetConcludeRequested, type ConcludeSilentAudit, type ReportRejectedAudit } from '../src/seeds/report.js';
import {
  SILENCE_DECLARE,
  SILENCE_DECLARE_CONCLUDE,
  buildMaterialPrompt,
  type MaterialInput,
} from '../src/core/material.js';
import { agentTurn } from '../src/core/orchestrator.js';
import { readAuditLines } from '../src/core/audit-log.js';
import { resetRuntimeForTest, setRuntime } from '../src/core/runtime.js';
import { loadUiConfig, saveUiConfig, uiConfigPath } from '../src/config/ui-config.js';

let sandbox = '';
beforeEach(() => {
  sandbox = sandboxDir('hb-conclude-');
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  resetRuntimeForTest();
  // B2 低1: the per-turn conclude flag lives in report.ts's module state —
  // reset it with everything else so one test's conclude cannot leak into
  // the next test's agentTurn gate.
  resetConcludeRequested();
  initWorkspace();
});
after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
});

interface Exec {
  concludeTurn?: () => void;
}

type Tool = { execute(args: unknown, exec?: Exec): Promise<{ ok: boolean; message: string }> };

function makeTool(
  isConcludeSilent?: () => boolean,
  audit?: (e: ConcludeSilentAudit) => void,
  currentDeliveryId?: () => string,
  onRejected?: (e: ReportRejectedAudit) => void,
): { guard: PathGuard; file: string; tool: Tool } {
  const dir = workspace().dataDir;
  const guard = createPathGuard(dir);
  const file = reportFilePath(dir);
  return {
    guard,
    file,
    tool: buildSeedReportTool(guard, file, isConcludeSilent, audit, currentDeliveryId, onRejected ? { onRejected } : undefined) as Tool,
  };
}

const M0: MaterialInput = { id: 's1', text: '他最近在学煮咖啡', used: 0 };

test('prompt: default keeps 本轮沉默; conclude mode forbids all body text', () => {
  const off = buildMaterialPrompt([M0]);
  assert.ok(off.includes(SILENCE_DECLARE));
  assert.ok(off.includes('本轮沉默'));
  assert.ok(!off.includes(SILENCE_DECLARE_CONCLUDE));

  const on = buildMaterialPrompt([M0], { concludeSilent: true });
  assert.ok(on.includes(SILENCE_DECLARE_CONCLUDE));
  assert.ok(on.includes('不要写任何正文'));
  assert.ok(!on.includes(SILENCE_DECLARE));
});

test('off: a silent report never calls concludeTurn (switch absent or false)', async () => {
  const variants: (undefined | (() => boolean))[] = [undefined, () => false];
  for (const [i, isConcludeSilent] of variants.entries()) {
    const id = `doff000${i + 1}`;
    const { guard, file, tool } = makeTool(isConcludeSilent, undefined, () => id);
    let calls = 0;
    const r = await tool.execute(
      { spoken: 'silent', reason: '不想说话', delivery_id: id },
      { concludeTurn: () => { calls += 1; } },
    );
    assert.equal(r.ok, true);
    assert.equal(calls, 0, 'the default rhythm must keep the turn open');
    assert.equal(readSeedReports(guard, file).length, i + 1, 'the account still lands');
  }
});

test('on: silent concludes the turn exactly once, and only after the report is on disk', async () => {
  const audited: ConcludeSilentAudit[] = [];
  const { guard, file, tool } = makeTool(() => true, (e) => audited.push(e), () => 'dcon0001');
  let calls = 0;
  const seen: (string | undefined)[] = [];
  const exec: Exec = {
    concludeTurn: () => {
      calls += 1;
      // Synchronous read INSIDE the stub: the report must already be visible.
      const all = readSeedReports(guard, file);
      seen.push(all[all.length - 1]?.deliveryId);
    },
  };
  const r = await tool.execute({ spoken: 'silent', reason: '在忙或刚聊过', delivery_id: 'dcon0001' }, exec);
  assert.equal(r.ok, true);
  assert.equal(calls, 1, 'exactly one concludeTurn');
  assert.deepEqual(seen, ['dcon0001'], 'the report (with its delivery id) landed before the conclude call');
  assert.equal(readSeedReports(guard, file).length, 1);
  assert.deepEqual(audited, [{ event: 'conclude_silent_requested', deliveryId: 'dcon0001' }]);
  assert.ok(r.message.includes('已结束'));
});

test('on: the switch is read BEFORE the write (a flip mid-execute cannot leak)', async () => {
  let seenAtEval = -1;
  const ctx = makeTool(() => {
    seenAtEval = readSeedReports(ctx.guard, ctx.file).length;
    return true;
  }, undefined, () => 'dord0001');
  await ctx.tool.execute({ spoken: 'silent', reason: '不想说话', delivery_id: 'dord0001' }, { concludeTurn: () => {} });
  assert.equal(seenAtEval, 0, 'the report was not yet on disk when the switch was evaluated');
});

test('on + no delivery id: the report is rejected and nothing is audited', async () => {
  const audited: ConcludeSilentAudit[] = [];
  const rejected: ReportRejectedAudit[] = [];
  const { guard, file, tool } = makeTool(() => true, (e) => audited.push(e), () => '', (e) => rejected.push(e));
  let calls = 0;
  const exec: Exec = { concludeTurn: () => { calls += 1; } };
  const missing = await tool.execute({ spoken: 'silent', reason: '不想说话' }, exec);
  const blank = await tool.execute({ spoken: 'silent', reason: '不想说话', delivery_id: '   ' }, exec);
  // P1-1 (2.3.0): without the package id the report is NOT booked (规格连带).
  assert.equal(missing.ok, false);
  assert.equal(blank.ok, false);
  assert.equal(calls, 0, 'without a delivery id we cannot tell whose silence this is');
  assert.ok(missing.message.includes('缺少 delivery_id'));
  assert.ok(blank.message.includes('缺少 delivery_id'));
  assert.equal(audited.length, 0);
  assert.deepEqual(rejected.map((e) => e.reason), ['unknown delivery', 'unknown delivery'], 'each rejection is audited');
  assert.equal(readSeedReports(guard, file).length, 0, 'a rejected report never lands in seed_report.jsonl');
});

test('R-D: a stale or typo’d delivery id is rejected, never concludes the running turn', async () => {
  let current = 'dcur0001';
  let calls = 0;
  const audited: ConcludeSilentAudit[] = [];
  const rejected: ReportRejectedAudit[] = [];
  const { guard, file, tool } = makeTool(() => true, (e) => audited.push(e), () => current, (e) => rejected.push(e));
  const stale = await tool.execute(
    { spoken: 'silent', reason: '不想说话', delivery_id: 'dold0001' },
    { concludeTurn: () => { calls += 1; } },
  );
  // P1-1 (2.3.0): a stale id is NOT this package's report (规格连带).
  assert.equal(stale.ok, false);
  assert.equal(calls, 0);

  // The delivery turn ended (id cleared): a late report is rejected too.
  current = '';
  const late = await tool.execute(
    { spoken: 'silent', reason: '不想说话', delivery_id: 'dcur0001' },
    { concludeTurn: () => { calls += 1; } },
  );
  assert.equal(late.ok, false);
  assert.equal(calls, 0);
  assert.deepEqual(rejected.map((e) => e.reason), ['unknown delivery', 'unknown delivery']);
  assert.deepEqual(rejected.map((e) => e.deliveryId), ['dold0001', 'dcur0001']);
  assert.equal(audited.length, 0, 'rejected reports are not conclude attempts');
  assert.equal(readSeedReports(guard, file).length, 0, 'neither rejected report lands');
});

test('on: material / heartfelt reports never conclude the turn', async () => {
  let current = 'dmat0001';
  const { guard, file, tool } = makeTool(() => true, undefined, () => current);
  let calls = 0;
  const exec: Exec = { concludeTurn: () => { calls += 1; } };

  const m = await tool.execute({ spoken: 'material', seed_ids: ['s1'], delivery_id: 'dmat0001' }, exec);
  assert.equal(m.ok, true);
  current = 'dhea0001';
  const h = await tool.execute({ spoken: 'heartfelt', delivery_id: 'dhea0001' }, exec);
  assert.equal(h.ok, true);
  assert.equal(calls, 0, 'only a silent report may end the turn');
  assert.equal(readSeedReports(guard, file).length, 2);
});

test('old host without concludeTurn: the silent report settles without throwing (audit: no-host-api)', async () => {
  const audited: ConcludeSilentAudit[] = [];
  let current = 'dold0001';
  const { guard, file, tool } = makeTool(() => true, (e) => audited.push(e), () => current);
  const noExec = await tool.execute({ spoken: 'silent', reason: '不想说话', delivery_id: 'dold0001' });
  assert.equal(noExec.ok, true);
  current = 'dold0002';
  const emptyExec = await tool.execute({ spoken: 'silent', reason: '不想说话', delivery_id: 'dold0002' }, {});
  assert.equal(emptyExec.ok, true);
  assert.equal(noExec.message.includes('宿主不支持'), true);
  const stored = readSeedReports(guard, file);
  assert.equal(stored.length, 2);
  assert.equal(stored[1]!.deliveryId, 'dold0002');
  assert.equal(audited.length, 2);
  for (const a of audited) {
    assert.equal(a.event, 'conclude_silent_failed');
    assert.equal(a.reason, 'no-host-api');
  }
  assert.deepEqual(audited.map((a) => a.deliveryId), ['dold0001', 'dold0002']);
});

test('host refusing concludeTurn: report stays settled, audit says threw', async () => {
  const audited: ConcludeSilentAudit[] = [];
  const { guard, file, tool } = makeTool(() => true, (e) => audited.push(e), () => 'dthrow01');
  const r = await tool.execute(
    { spoken: 'silent', reason: '不想说话', delivery_id: 'dthrow01' },
    { concludeTurn: () => { throw new Error('turn already closed'); } },
  );
  assert.equal(r.ok, true, 'a host-side refusal must not undo a settled report');
  assert.ok(r.message.includes('失败'));
  assert.equal(readSeedReports(guard, file).length, 1);
  assert.equal(audited.length, 1);
  assert.equal(audited[0]!.event, 'conclude_silent_failed');
  assert.equal(audited[0]!.reason, 'threw');
  assert.ok(audited[0]!.error?.includes('turn already closed'));
});

// ── P15-2 (2.3.0): the runtime half of the conclude contract ─────────────
// With concludeSilentTurn on, a silent EXPRESSION turn ends normally with ZERO
// body text, so agentTurn finds no assistant line. That is the expected shape
// and must be audited as turn_concluded — not as the turn_extraction_empty
// fault line the old code faked once per beat. Gated three ways (B2 中1+中2):
// the switch, the 'expression' label (weekly/browse zero-text ends stay
// faults), and the real end-kind allowlist — the host's normal conclusion is
// 'completed' (B2 低7: fixtures use the real kind, not the invented
// 'end_turn'); blocked/error/aborted/interrupted/max-tokens/forked are all
// failures and keep the fault line.

interface FakeEvent { type: string; data?: unknown }

/** The host's REAL normal-conclusion kind (B2 低7): fixtures pin the real
 *  path, not a plausible-looking fake. */
const COMPLETED = 'completed';

/** A minimal fake host agent: the log starts with one pre-existing event, and
 *  `followup` appends the turn's events the way the real host logs them — the
 *  extraction window is everything AFTER the pre-existing count. */
function fakeAgent(turnEvents: FakeEvent[]): Parameters<typeof agentTurn>[1] {
  const log: FakeEvent[] = [{ type: 'user/message', data: {} }];
  return {
    id: 'agent-test',
    session: { events: log } as never,
    followup: () => { log.push(...turnEvents); },
    whenIdle: async () => {},
  } as Parameters<typeof agentTurn>[1];
}

/** Point the runtime singleton at a stub whose only live flag is
 *  concludeSilentTurn — the gate agentTurn reads for turn_concluded. */
function runtimeWithConclude(on: boolean): void {
  setRuntime({
    paths: {} as never, guard: {} as never, policy: {} as never,
    flags: {
      statusbarEnabled: () => false,
      timeInjectMin: () => 0,
      idleMode: () => false,
      tokenSaver: () => false,
      visionEngine: () => '',
      concludeSilentTurn: () => on,
    },
  } as never);
}

function fakeDeps(logsDir: string): Parameters<typeof agentTurn>[0] {
  return { paths: { logsDir } } as unknown as Parameters<typeof agentTurn>[0];
}

test('P15-2: switch ON — an expression turn ending completed with zero text audits turn_concluded', async () => {
  runtimeWithConclude(true);
  // B2 低1: the gate's fourth condition — the conclude must have been REALLY
  // requested this turn (the real path: seed_report called concludeTurn and
  // report.ts marked the flag). Production reaches here via the tool.
  markConcludeRequested();
  const logsDir = path.join(sandbox, 'logs-concluded');
  const agent = fakeAgent([
    { type: 'user/message', data: {} },
    { type: 'turn/end', data: { reason: { kind: COMPLETED } } },
  ]);
  const text = await agentTurn(fakeDeps(logsDir), agent, 'prompt', 'expression');
  assert.equal(text, '', 'no assistant text exists');
  const lines = readAuditLines(logsDir + '/heartbeat.jsonl') as { event: string; kind?: string; label?: string }[];
  const concluded = lines.filter((l) => l.event === 'turn_concluded');
  assert.equal(concluded.length, 1, JSON.stringify(lines));
  assert.equal(concluded[0]!.kind, COMPLETED);
  assert.equal(concluded[0]!.label, 'expression');
  assert.equal(lines.some((l) => l.event === 'turn_extraction_empty'), false, 'no fake fault line');
});

test('B2 低1: switch ON + completed + zero text but NO conclude request — the fault line stays', async () => {
  // The exact shape P15-2 exists to catch: the model only produced thinking
  // blocks (assistantText filters reasoning at extraction), or a tool round
  // ended with no body — with the switch on this used to be renamed into a
  // conclusion. The per-turn flag (set ONLY by a real concludeTurn request)
  // keeps it an honest fault. Drop `&& wasConcludeRequested()` from the gate
  // and this goes RED (turn_concluded appears).
  runtimeWithConclude(true);
  const logsDir = path.join(sandbox, 'logs-no-request');
  const agent = fakeAgent([
    { type: 'user/message', data: {} },
    { type: 'turn/end', data: { reason: { kind: COMPLETED } } },
  ]);
  assert.equal(await agentTurn(fakeDeps(logsDir), agent, 'p', 'expression'), '');
  const lines = readAuditLines(logsDir + '/heartbeat.jsonl') as { event: string }[];
  assert.deepEqual(lines.map((l) => l.event), ['turn_extraction_empty'], JSON.stringify(lines));
  assert.equal(lines.some((l) => l.event === 'turn_concluded'), false,
    'a zero-text turn without a conclude request is NOT a conclusion');
});

// ── B2 rework a2 测试洞 1/2 (2.3.0): the OTHER two gate conditions were never
// exercised — a conclude REQUEST alone (the new flag) made the weekly test
// pass and the end-kind test pass, so dropping `label === 'expression'` or
// regressing the allowlist to the old blocked/error blacklist kept everything
// green. Each gate condition below gets its own red.

test('B2-a3 洞1: switch ON + conclude requested but label weekly — the label gate keeps the fault', async () => {
  // Remove `label === 'expression' &&` from the gate and this goes RED: the
  // weekly turn (with a conclude request riding over from a stale flag) is
  // renamed into a conclusion. Ends with resetConcludeRequested so the
  // flag cannot leak into the next test.
  runtimeWithConclude(true);
  markConcludeRequested();
  const logsDir = path.join(sandbox, 'logs-weekly-requested');
  const agent = fakeAgent([
    { type: 'user/message', data: {} },
    { type: 'turn/end', data: { reason: { kind: COMPLETED } } },
  ]);
  assert.equal(await agentTurn(fakeDeps(logsDir), agent, 'p', 'weekly'), '');
  const lines = readAuditLines(logsDir + '/heartbeat.jsonl') as { event: string; label?: string }[];
  assert.deepEqual(lines.map((l) => l.event), ['turn_extraction_empty'], JSON.stringify(lines));
  assert.equal(lines.some((l) => l.event === 'turn_concluded'), false,
    'a weekly turn is never a conclusion, even with a conclude request in the flag');
  resetConcludeRequested();
});

test('B2-a3 洞2: switch ON + conclude requested + failure end kind — the allowlist keeps the fault', async () => {
  // Regression the reviewer proved possible: swapping the allowlist back to
  // the old `endKind !== 'blocked' && endKind !== 'error'` blacklist kept all
  // 49 tests green, because nothing ran a FAILURE kind with the flag set.
  // aborted / max-tokens with a conclude request must stay faults.
  runtimeWithConclude(true);
  markConcludeRequested();
  const logsDir = path.join(sandbox, 'logs-failed-requested');
  for (const kind of ['aborted', 'max-tokens'] as const) {
    const agent = fakeAgent([{ type: 'turn/end', data: { reason: { kind } } }]);
    assert.equal(await agentTurn(fakeDeps(logsDir), agent, 'p', 'expression'), '', kind);
  }
  const lines = readAuditLines(logsDir + '/heartbeat.jsonl') as { event: string }[];
  assert.deepEqual(lines.map((l) => l.event), ['turn_extraction_empty', 'turn_extraction_empty'], JSON.stringify(lines));
  assert.equal(lines.some((l) => l.event === 'turn_concluded'), false,
    'a cut-short reply is never a conclusion, even with a conclude request in the flag');
  resetConcludeRequested();
});

test('B2 中1: switch ON — a WEEKLY zero-text completed turn is still a fault line', async () => {
  runtimeWithConclude(true);
  const logsDir = path.join(sandbox, 'logs-weekly');
  const agent = fakeAgent([
    { type: 'user/message', data: {} },
    { type: 'turn/end', data: { reason: { kind: COMPLETED } } },
  ]);
  assert.equal(await agentTurn(fakeDeps(logsDir), agent, 'prompt', 'weekly'), '');
  const lines = readAuditLines(logsDir + '/heartbeat.jsonl') as { event: string; label?: string }[];
  assert.deepEqual(lines.map((l) => l.event), ['turn_extraction_empty'], JSON.stringify(lines));
  assert.equal(lines.some((l) => l.event === 'turn_concluded'), false,
    'only the expression turn can carry a conclude request — weekly must not be renamed');
});

test('P15-2: switch ON — failure kinds keep the turn_extraction_empty fault line (B2 中2)', async () => {
  runtimeWithConclude(true);
  const logsDir = path.join(sandbox, 'logs-failed');
  const blocked = fakeAgent([{ type: 'turn/end', data: { reason: { kind: 'blocked' } } }]);
  assert.equal(await agentTurn(fakeDeps(logsDir), blocked, 'p', 'expression'), '');
  const error = fakeAgent([
    { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'NO_ADAPTER', message: 'no adapter' } } } },
  ]);
  assert.equal(await agentTurn(fakeDeps(logsDir), error, 'p', 'expression'), '');
  // B2 中2: aborted / interrupted / max-tokens / forked are real host kinds —
  // each is a cut-short reply, never a conclusion.
  for (const kind of ['aborted', 'interrupted', 'max-tokens', 'forked'] as const) {
    const agent = fakeAgent([{ type: 'turn/end', data: { reason: { kind } } }]);
    assert.equal(await agentTurn(fakeDeps(logsDir), agent, 'p', 'expression'), '', kind);
  }
  const lines = readAuditLines(logsDir + '/heartbeat.jsonl') as { event: string; turnError?: string }[];
  assert.equal(lines.length, 6, JSON.stringify(lines.map((l) => l.event)));
  assert.equal(lines.every((l) => l.event === 'turn_extraction_empty'), true, JSON.stringify(lines.map((l) => l.event)));
  assert.ok(lines[1]!.turnError?.includes('NO_ADAPTER'), lines[1]!.turnError);
});

test('P15-2: switch OFF (the default) — a zero-text normal end is STILL a fault line (review a1)', async () => {
  runtimeWithConclude(false);
  const logsDir = path.join(sandbox, 'logs-off');
  const agent = fakeAgent([{ type: 'turn/end', data: { reason: { kind: COMPLETED } } }]);
  assert.equal(await agentTurn(fakeDeps(logsDir), agent, 'p', 'expression'), '');
  const lines = readAuditLines(logsDir + '/heartbeat.jsonl') as { event: string; kind?: string }[];
  assert.deepEqual(lines.map((l) => l.event), ['turn_extraction_empty'], JSON.stringify(lines));
  assert.equal(lines.some((l) => l.event === 'turn_concluded'), false, 'the fault must not be renamed into a conclusion');
});

test('P15-2: runtime unset reads the switch as off, and a spoke turn audits nothing', async () => {
  // resetRuntimeForTest ran in beforeEach: no runtime singleton at all —
  // agentTurn must not throw and must keep the fault-line path.
  const logsDir = path.join(sandbox, 'logs-unset');
  const silentAgent = fakeAgent([{ type: 'turn/end', data: { reason: { kind: COMPLETED } } }]);
  assert.equal(await agentTurn(fakeDeps(logsDir), silentAgent, 'p', 'expression'), '');
  let lines = readAuditLines(logsDir + '/heartbeat.jsonl') as { event: string }[];
  assert.deepEqual(lines.map((l) => l.event), ['turn_extraction_empty']);

  const spokeAgent = fakeAgent([
    { type: 'assistant/message', data: { content: [{ type: 'text', text: '说到咖啡，我最近也在喝' }] } },
    { type: 'turn/end', data: { reason: { kind: COMPLETED } } },
  ]);
  const text = await agentTurn(fakeDeps(logsDir), spokeAgent, 'prompt', 'expression');
  assert.ok(text.includes('咖啡'));
  lines = readAuditLines(logsDir + '/heartbeat.jsonl') as { event: string }[];
  assert.equal(lines.length, 1, 'a spoke turn adds no audit event');
});

test('ui-config: concludeSilentTurn defaults to false; only a real boolean is stored', () => {
  const settingsDir = path.join(sandbox, 'settings');
  const guard = createPathGuard(sandbox);
  const file = uiConfigPath(settingsDir);
  fs.mkdirSync(settingsDir, { recursive: true });

  fs.writeFileSync(file, JSON.stringify({ concludedSilentTurn: true, concludeSilentTurn: 'yes' }), 'utf8');
  assert.equal(loadUiConfig(guard, settingsDir).concludeSilentTurn, undefined, 'a string is not a boolean');
  assert.equal(loadUiConfig(guard, settingsDir).intervalMin, undefined);

  fs.writeFileSync(file, JSON.stringify({ concludeSilentTurn: true }), 'utf8');
  assert.equal(loadUiConfig(guard, settingsDir).concludeSilentTurn, true);

  const merged = saveUiConfig(guard, settingsDir, { concludeSilentTurn: false });
  assert.equal(merged.concludeSilentTurn, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).concludeSilentTurn, false);
});
