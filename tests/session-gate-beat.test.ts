// P0-4 beat-level integration: the real beat entry (observe → gate →
// auto-removal), not just the gate unit. A healthy binding must survive a beat
// with `observed` written and no `session_skipped`; a broken binding that hits
// the strike threshold must be removed from bindings.json AND have its strike
// entry cleared, so a re-bind starts at zero.
//
// ── N18 rework 覆盖矩阵（哪一处 → 哪条用例 → 去掉后红在哪条断言）──
//   （按函数/代码块引用，不写行号——行号会漂）
//   orchestrator.ts beat 边界归口（`cancelled = instanceof || ctl.signal.aborted`）
//     → 本文件「beat: a plain-error failure while the signal aborts is
//       beat_aborted, not beat_error (N18 rework 中1/中2)」
//     → 去掉归口 → 红 "the beat was booked as cancelled exactly once"
//       （beat_aborted 缺席，且 beat_error 行出现——主证据）。
//   vision.ts describeScreenShotNative 的 catch 顶部 rethrow
//     → ② 联合钉：它与 router 的 abort 判定同时去掉 → 首红在 ② 用例的 error
//       文本断言「低4: a rethrow-style abort keeps the error text for
//       traceability」（a4 交叉审查 6e003c35 实测：被吞的中止变成普通失败，
//       低4 error 字段文本随变异改变，先于 screen_vision 缺席断言变红）；
//       单独兜底用例：vision-native.test.ts「auto: an abort at the vision
//       entry propagates — no ModLens spawn, no ok:false (N18)」（去掉 → 红在
//       期望的 BeatAbortedError 拒绝变成普通 ok:false 返回）。
//       A6 低1 实测修正：screen_vision 缺席断言不是三处删除的首红——三处
//       （native catch / router 判定 / viaModlens 入口）同删时，modlensFailure
//       仍会抛（A6 低3 起是 BeatAbortedError('vision')），首红是同用例的 stage
//       断言（'vision' ≠ 期望的 'unknown'）；要凑满五处删除（再加 modlensFailure
//       的 abort 抛 + viaModlens 事后判定）才轮到缺席断言。配方写在 ② 用例内注释。
//   vision.ts describeScreenVision（router）的 abort 判定（在 engine==='native'
//   的 return 之前）
//     → vision-native.test.ts「native: an aborted beat never returns
//       ok:false — the abort wins over the engine result (N18 rework 中2)」
//     → 判定挪回 return 之后 → 红 "Missing expected rejection"。
//   vision.ts describeScreenShot 的 modlensFailure 助手（失败返回 abort 感知）
//     → vision-native.test.ts「modlens: a CLI run rejected on an aborted
//       signal propagates — not ok:false (N18 rework 中2)」与 a3 中1 的
//       「modlens: no screenshot / CLI exit nonzero on an aborted signal
//       propagate」两条（去掉 → 红 "Missing expected rejection: …"）。
//   vision.ts describeScreenVision 的 viaModlens 入口检查
//     → vision-native.test.ts「modlens: an aborted beat never even starts a
//       ModLens run (N18-a3 中1)」。
//   index.ts auditInvalidVisionEngines 先 write 后 add（低1 + a3 中3）
//     → vision-native.test.ts「auditInvalidVisionEngines: a failed write does
//       not consume the key — it retries next beat (N18 rework 低1)」与生产
//       writer 集成用例「…a production appendAuditLine failure does not
//       consume the key (N18-a3 中3)」。
//   orchestrator.ts 四个 catch（决策轮 / 表达轮 / weekly 内外 / observe 每绑定）
//     顶部的 `if (bc.signal.aborted) throw e`——首红断言按 a4 变异实测写
//     （M12–M15 全部跑红后还原；6e003c35 独立复核一致）：
//     → 决策轮：本文件「beat: an abort landing in the decision turn unwinds as
//       beat_aborted, not decision_deferred (N18-a3 中2)」——首红 "the
//       cancellation reached the beat boundary exactly once"（beat_aborted 缺
//       席、decision_deferred 出现）。
//     → weekly 内层（weekly turn catch）：本文件「beat: an abort landing in the
//       weekly turn unwinds as beat_aborted, not a template report (N18-a4)」
//       ——删内层 rethrow → 首红 stage 断言 "the abort names the stage it
//       landed in"（weekly_llm_failed 落账 + 模板报告生成，中止漂到 collect，
//       stage 实际 'collect' ≠ 'weekly'）。
//     → weekly 外层（weeklyPhase catch）：同一条用例——删外层 rethrow → 首红
//       同一条 stage 断言；beat_aborted 仍出现（stage 落在 'collect'，并非缺
//       席），weekly_failed 落账。两层各删一次都红，红在同一处。
//     → observe 每绑定 catch：本文件「beat: an abort landing in the observe
//       read path unwinds as beat_aborted, not observe_error (N18-a4)」
//       ——删该 rethrow → 首红 "a cancellation must not be booked as
//       observe_error"；beat_aborted 仍出现但落在 collect 阶段（本用例没有
//       error 字段断言——withTimeout 的 guard 在 abort 瞬间 reject 出
//       BeatAbortedError('collect')，必胜过 rethrow 式 plain Error，见用例注释）。
//     → 表达轮 catch（A9，deliverPackage 的 expression 轮）：本文件「beat: an
//       abort landing in the spoken (expression) turn unwinds as beat_aborted,
//       not spoke_deferred (N18-a4 expression rethrow, A9)」——a3 评审以为有
//       既有用例在全量下钉它，a4 实测 M15 探针 641 全绿（vision-native 的
//       causes[1] 钉的是 nativeVisionTurn 单元层，到不了这个 catch），故由该
//       新用例直接承担覆盖；首红 "the cancellation reached the beat boundary
//       exactly once"（beat_aborted 缺席，spoke_deferred 出现）。
//   既定窗口（如实写明，a4 交叉审查 ③）：deliverPackage 尾段 `await
//     sendNewMessageHint(paths)` 到 beat 层 writeBeatStatus 之间没有 abort
//     检查——abort 落在这个窗口时投递正常收尾（'spoke' 记账、状态照写），
//     beat 不以 beat_aborted 收场。这是既定行为（窗口极窄：一次 toast spawn），
//     未加检查；任何在表达轮 catch 之后还想去补检查的想法都属生产逻辑变更，
//     需要评审拍板，测试侧不做。
//   低5 的 saveImage 前 throwIfAborted（nativeVisionTurn）
//     → vision-native.test.ts「nativeVisionTurn: an abort during the probe
//       stops before the image is stored (N18-a3 低5)」。
//   「构造不出」的准确说法（q-2426e82ef7beec10 低7 修正）：不是 modlens 的
//   beat 级用例整体构造不出——engine 可由 flags 注入；构造不出的是「abort
//   落在 vision 执行中」的窗口（modlens 未安装 → resolveModlensMain null →
//   describeScreenShot 全同步 early-return 无 await 窗口；abort 落在决策轮会被
//   中2 的 catch 归口、落点追不上 vision）。ctl 只能被看护狗/阶段 ceiling/
//   disposer 中止，fake 只拿得到 signal。该窗口的覆盖由单元级用例 + beat 级
//   disposer 车辆用例承担（q-f31eafcfb2decd5d / q-2426e82ef7beec10）。

import { sandboxDir } from './_sandbox.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import { resetRuntimeForTest, setRuntime, getCurrentDeliveryId, getRuntime } from '../src/core/runtime.js';
import { addBinding, loadBindings } from '../src/core/bindings.js';
import { resetSessionGateCache } from '../src/core/session-gate.js';
import { buildSeedReportTool, reportFilePath, resetConcludeRequested, wasConcludeRequested, markConcludeRequested } from '../src/seeds/report.js';
import { sentFilePath } from '../src/gate/gate.js';
import { appendAuditLine } from '../src/core/audit-log.js';
import { savePool, seedsFilePath } from '../src/seeds/pool.js';
import {
  beat,
  getLastBeat,
  resetHomeAgent,
  startOrchestrator,
  type OrchestratorDeps,
} from '../src/core/orchestrator.js';
import type { Policy } from '../src/config/schema.js';

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;

beforeEach(() => {
  sandbox = sandboxDir('hb-gate-beat-');
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  resetConcludeRequested();
  initWorkspace();
  guard = createPathGuard(workspace().dataDir);
  resetSessionGateCache();
  resetHomeAgent();
});

after(() => {
  resetRuntimeForTest();
  resetHomeAgent();
  resetWorkspaceForTest();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const POLICY: Policy = {
  heartbeat: { intervalMin: 20, idleMode: false, archiveRotatedHome: false },
  gate: { maxDailySend: 8, cooldownMinutes: 30, quietHours: { start: '00:00', end: '00:00' } },
  browse: { windows: [], minIntervalHours: 4, maxSeedsPerVisit: 5 },
  seeds: {
    maxActive: 50,
    ttlDays: { news: 7, fandom: 7, scene: 3, promise: 30 },
    coldBenchDays: 7,
    archiveCap: 100,
    retireAfterUsed: 3,
    scoreWeights: { freshness: 0.5, unused: 0.3, confidence: 0.2 },
  },
  profile: {
    consolidation: { minIntervalHours: 24, inboxBacklog: 20 },
    partitionCap: 80,
    maxOpsPerRun: 6,
    confidenceCap: { chat: 1, screen: 1, browse: 1 },
    volatileDays: 7,
    stableLowActivityDays: 14,
    psyEnabled: false,
  },
  observe: { maxChars: 200, perBeat: 10 },
  weekly: { enabled: false, keepReports: 4 },
  retention: { envPulseHours: 24, decisionLogDays: 30 },
};

function stubAgent(id: string, session: unknown): Record<string, unknown> {
  return {
    id,
    session,
    options: { model: 'test-model' },
    followup: () => {},
    whenIdle: async () => {},
    cancel: () => {},
  };
}

/** One real beat against a minimal host: no seeds (expression stays silent),
 *  missing assets (every probe degrades at once), and one live bound agent.
 *  `opts` (N2/N8 beat cases): swap the home agent, expose host services via
 *  ctx.get, pin the vision engine, or turn idleMode on. */
function makeHarness(
  boundId: string,
  boundAgent: Record<string, unknown>,
  opts: {
    home?: Record<string, unknown>;
    services?: Record<string, unknown>;
    visionEngine?: string;
    idleMode?: boolean;
    assetsDir?: string;
    /** Captures the orchestrator's real teardown (ctx.effect factory return),
     *  so a test can dispose mid-beat exactly like the host does. */
    onEffect?: (teardown: () => void) => void;
    /** a4: turn the weekly phase on (POLICY ships it disabled). Pair with a
     *  pre-written weekly/state.json whose lastGeneratedAt is ≥7 days old to
     *  make the beat actually enter the weekly turn. */
    weekly?: boolean;
  } = {},
): OrchestratorDeps {
  const paths = { ...workspace(), assetsDir: opts.assetsDir ?? path.join(sandbox, 'missing-assets') };
  const home = opts.home ?? stubAgent('hb-home', { id: 'session-home', events: [], snapshotEvents: () => [] });
  fs.mkdirSync(paths.settingsDir, { recursive: true });
  fs.writeFileSync(path.join(paths.settingsDir, 'interests.json'), '{"interests":[],"_schedule":{}}', 'utf8');
  const policy = opts.idleMode
    ? { ...POLICY, heartbeat: { ...POLICY.heartbeat, idleMode: true } }
    : POLICY;
  const beatPolicy = opts.weekly
    ? { ...policy, weekly: { ...policy.weekly, enabled: true } }
    : policy;
  const ctx = {
    agents: {
      create: async () => ({ agent: home }),
      resume: async () => ({ agent: home }),
      roots: () => [],
      get: (id: string) => (id === boundId ? boundAgent : undefined),
    },
    // nativeVisionTurn probes host services (attachments / llm) through ctx.get.
    get: (name: string) => (opts.services ? opts.services[name] : undefined),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    // host contract: ctx.effect(factory) — the host keeps the returned teardown
    // and calls it on unload. Capture it when the test asks for it.
    effect: (fn: () => unknown) => {
      const teardown = (fn as () => () => void)();
      if (opts.onEffect) opts.onEffect(teardown);
      return () => {};
    },
  };
  const deps = { ctx, paths, guard, policy: beatPolicy } as unknown as OrchestratorDeps;
  setRuntime({
    paths,
    guard,
    policy: beatPolicy,
    flags: {
      statusbarEnabled: () => false,
      timeInjectMin: () => 0,
      idleMode: () => opts.idleMode === true,
      tokenSaver: () => false,
      visionEngine: () => opts.visionEngine ?? '',
    },
  });
  return deps;
}

/** Bounded await for a parking handshake — and for the beat promise itself.
 *  A6 中1: when a mutation stops the vehicle before the parked point, the test
 *  must fail on its own instead of wedging the whole runner until an external
 *  kill (the disposer only runs in `finally` once the await settles). */
async function within<T>(p: Promise<T>, what: string, ms = 20_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function auditEvents(): {
  event: string;
  sessionId?: string;
  reason?: string;
  engine?: string;
  ok?: boolean;
  error?: string;
  nativeError?: string;
  stage?: string;
  why?: string;
}[] {
  const file = path.join(workspace().logsDir, 'heartbeat.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as {
      event: string;
      sessionId?: string;
      reason?: string;
      engine?: string;
      ok?: boolean;
      error?: string;
      nativeError?: string;
      stage?: string;
      why?: string;
    });
}

/** One active topic seed so expression reaches the decision turn and then
 *  deliverPackage (which is where unreachable targets are counted). */
function seedPool(): void {
  const now = Date.now();
  savePool(guard, seedsFilePath(workspace().dataDir), {
    seq: 1,
    seeds: [{
      id: 's1',
      text: '一条用于不可拉起测试的素材',
      topic: '投递测试',
      tag: 'news',
      source: 'browse',
      category: 'topic',
      confidence: 0.5,
      protected: false,
      used: 0,
      bornAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 6 * 86_400_000).toISOString(),
      lastUsedAt: null,
      lastEvidenceAt: new Date(now).toISOString(),
      status: 'active',
    }],
  });
}

/** Home agent whose followup appends the decision JSON the expression phase
 *  parses, so deliverPackage is actually reached. */
function decisionAgent(): Record<string, unknown> {
  const events: { type: string; data?: unknown }[] = [];
  return {
    id: 'hb-home',
    session: { id: 'session-home', events, snapshotEvents: () => events },
    options: { model: 'test-model' },
    followup: () => {
      events.push({
        type: 'assistant/message',
        data: { content: [{ type: 'text', text: '{"seed_ids":["s1"]}' }] },
      });
    },
    whenIdle: async () => {},
    cancel: () => {},
  };
}

/** Beat harness for the delivery path: the bound session is deliberately NOT
 *  live (`agents.get` misses); resume either fails or returns `boundAgent`. */
function makeDeliveryHarness(
  boundId: string,
  home: Record<string, unknown>,
  resumeBound: () => Record<string, unknown> | null,
): OrchestratorDeps {
  const paths = { ...workspace(), assetsDir: path.join(sandbox, 'missing-assets') };
  fs.mkdirSync(paths.settingsDir, { recursive: true });
  fs.writeFileSync(path.join(paths.settingsDir, 'interests.json'), '{"interests":[],"_schedule":{}}', 'utf8');
  const homeId = (home.session as { id: string }).id;
  const ctx = {
    agents: {
      create: async () => ({ agent: home }),
      resume: async (req: { resumeSessionId?: string }) => {
        if (req.resumeSessionId === boundId) {
          const agent = resumeBound();
          if (!agent) throw new Error('session log unreadable');
          return { agent };
        }
        return { agent: home };
      },
      roots: () => [],
      get: (id: string) => (id === boundId ? undefined : id === homeId ? home : undefined),
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (fn: () => unknown) => { fn(); return () => {}; },
  };
  const deps = { ctx, paths, guard, policy: POLICY } as unknown as OrchestratorDeps;
  setRuntime({
    paths,
    guard,
    policy: POLICY,
    flags: {
      statusbarEnabled: () => false,
      timeInjectMin: () => 0,
      idleMode: () => false,
      tokenSaver: () => false,
      visionEngine: () => '',
    },
  });
  return deps;
}

function strikeCount(sessionId: string): number | undefined {
  const file = path.join(workspace().settingsDir, 'state.json');
  if (!fs.existsSync(file)) return undefined;
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    brokenStrikes?: Record<string, { count: number }>;
  };
  return state.brokenStrikes?.[sessionId]?.count;
}

test('beat: a healthy binding stays, observed is written, and no session is skipped', async () => {
  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: '今天在写插件' }] } }];
  const bound = stubAgent('agent-bound', { id: 'session-bound', events, snapshotEvents: () => events });
  addBinding(guard, workspace().settingsDir, 'session-bound', { deliver: true, observe: true });
  const deps = makeHarness('session-bound', bound);

  try {
    await beat(deps, 'interval');
  } finally {
    resetRuntimeForTest();
  }

  assert.ok(
    loadBindings(guard, workspace().settingsDir).bindings.some((b) => b.sessionId === 'session-bound'),
    'healthy binding survives the beat',
  );
  const observed = auditEvents().filter((e) => e.event === 'observed' && e.sessionId === 'session-bound');
  assert.equal(observed.length, 1, 'observe phase ran through the gate');
  assert.equal(
    auditEvents().filter((e) => e.event === 'session_skipped' && e.sessionId === 'session-bound').length,
    0,
    'a healthy session is never audited as skipped',
  );
});

test('beat: the third broken strike removes the binding and clears its strike entry', async () => {
  const throwing = {
    id: 'session-broken',
    snapshotEvents: () => { throw new Error('session log unreadable'); },
  };
  const bound = stubAgent('agent-broken', throwing);
  addBinding(guard, workspace().settingsDir, 'session-broken', { deliver: true, observe: true });
  // Two earlier bad beats already landed in state.json.
  const stateFile = path.join(workspace().settingsDir, 'state.json');
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ brokenStrikes: { 'session-broken': { count: 2, lastAt: '2026-11-17T00:00:00.000Z' } } }),
    'utf8',
  );
  resetSessionGateCache();
  const deps = makeHarness('session-broken', bound);

  try {
    await beat(deps, 'interval');
  } finally {
    resetRuntimeForTest();
  }

  assert.equal(
    loadBindings(guard, workspace().settingsDir).bindings.some((b) => b.sessionId === 'session-broken'),
    false,
    'binding was auto-removed after the third strike',
  );
  assert.ok(
    auditEvents().some((e) => e.event === 'binding_auto_removed' && e.sessionId === 'session-broken'),
    'removal is audited',
  );
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as {
    brokenStrikes?: Record<string, { count: number }>;
  };
  assert.equal(state.brokenStrikes?.['session-broken'], undefined, 'strike entry is cleared with the binding');
});

test('beat: an unresumable target keeps its binding for 2 beats, then is removed on the 3rd', async () => {
  seedPool();
  addBinding(guard, workspace().settingsDir, 'session-unreachable', { deliver: true, observe: false });
  const home = decisionAgent();
  const deps = makeDeliveryHarness('session-unreachable', home, () => null);

  try {
    await beat(deps, 'interval'); // resume attempt #1 fails
    assert.ok(loadBindings(guard, workspace().settingsDir).bindings.some((b) => b.sessionId === 'session-unreachable'));
    assert.equal(strikeCount('session-unreachable'), 1);
    assert.equal(auditEvents().filter((e) => e.event === 'binding_auto_removed').length, 0);

    await beat(deps, 'interval'); // #2 fails
    assert.ok(loadBindings(guard, workspace().settingsDir).bindings.some((b) => b.sessionId === 'session-unreachable'));
    assert.equal(strikeCount('session-unreachable'), 2);
    assert.equal(auditEvents().filter((e) => e.event === 'binding_auto_removed').length, 0);

    await beat(deps, 'interval'); // #3 crosses the threshold
  } finally {
    resetRuntimeForTest();
  }

  assert.equal(
    loadBindings(guard, workspace().settingsDir).bindings.some((b) => b.sessionId === 'session-unreachable'),
    false,
    'third unreachable beat removes the binding',
  );
  assert.equal(
    auditEvents().filter((e) => e.event === 'binding_auto_removed' && e.sessionId === 'session-unreachable').length,
    1,
    'removal is audited exactly once',
  );
  assert.equal(auditEvents().find((e) => e.event === 'binding_auto_removed')?.reason, 'unreachable');
  assert.equal(strikeCount('session-unreachable'), undefined, 'strike entry dies with the binding');
});

test('beat: one successful acquire in the middle clears the unreachable count', async () => {
  seedPool();
  addBinding(guard, workspace().settingsDir, 'session-recovering', { deliver: true, observe: false });
  const home = decisionAgent();
  const recovered = stubAgent('agent-recovered', {
    id: 'session-recovering',
    events: [{ type: 'user/message' }],
    snapshotEvents: () => [{ type: 'user/message' }],
  });
  let reachable = false;
  const deps = makeDeliveryHarness('session-recovering', home, () => (reachable ? recovered : null));

  try {
    await beat(deps, 'interval'); // fail → strike 1
    assert.equal(strikeCount('session-recovering'), 1);

    reachable = true;
    await beat(deps, 'interval'); // acquire succeeds; gate's allowed branch clears
    assert.equal(strikeCount('session-recovering'), undefined);

    reachable = false;
    await beat(deps, 'interval'); // fail again → strike 1, not 3
  } finally {
    resetRuntimeForTest();
  }

  assert.ok(
    loadBindings(guard, workspace().settingsDir).bindings.some((b) => b.sessionId === 'session-recovering'),
    'binding survives: the streak restarted',
  );
  assert.equal(strikeCount('session-recovering'), 1);
  assert.equal(
    auditEvents().filter((e) => e.event === 'binding_auto_removed' && e.sessionId === 'session-recovering').length,
    0,
  );
});

// ── N17 (p04 收尾审查): beat 级 H-archived / 重复 sessionId 去重 ──────────
// The gate unit tests above never exercise the DELIVER pre-pass against the
// real disk registry, and a hand-edited bindings.json can carry the same
// sessionId twice — both need a full beat to be pinned.

test('beat: an archived deliver target is unbound by the pre-pass and never resumed (N17 H-archived)', async () => {
  seedPool();
  addBinding(guard, workspace().settingsDir, 'session-archived', { deliver: true, observe: false });
  // H-archived disk truth: <dshHome>/storages/workspace.json → global.archivedSessionIds.
  const storages = path.join(sandbox, 'storages');
  fs.mkdirSync(storages, { recursive: true });
  fs.writeFileSync(
    path.join(storages, 'workspace.json'),
    JSON.stringify({ global: { archivedSessionIds: ['session-archived'] } }),
    'utf8',
  );
  process.env.DSH_HOME = sandbox;
  const home = decisionAgent();
  const deps = makeDeliveryHarness('session-archived', home, () => null);
  try {
    await beat(deps, 'interval');
  } finally {
    delete process.env.DSH_HOME;
    resetRuntimeForTest();
  }
  assert.equal(
    loadBindings(guard, workspace().settingsDir).bindings.some((b) => b.sessionId === 'session-archived'),
    false,
    'the archived binding is auto-removed by the deliver pre-pass',
  );
  assert.ok(
    auditEvents().some((e) => e.event === 'binding_auto_removed' && e.sessionId === 'session-archived' && e.reason === 'archived'),
    'the removal is audited with the archived reason',
  );
  assert.equal(
    auditEvents().filter((e) => e.event === 'deliver_target_resumed' && e.sessionId === 'session-archived').length,
    0,
    'the archived session is never brought live (deliver_target_resumed must not appear)',
  );
});

test('beat: a hand-edited duplicate sessionId takes one strike per beat and dies on the third (N17)', async () => {
  seedPool();
  const settingsDir = workspace().settingsDir;
  // Hand-written bindings.json: the SAME session twice (addBinding would
  // dedupe — only manual edits or external writers can produce this).
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(settingsDir, 'bindings.json'), JSON.stringify({
    bindings: [
      { sessionId: 'session-dup', deliver: true, observe: false, addedAt: now },
      { sessionId: 'session-dup', deliver: true, observe: false, addedAt: now },
    ],
  }), 'utf8');
  const home = decisionAgent();
  const deps = makeDeliveryHarness('session-dup', home, () => null);
  try {
    await beat(deps, 'interval');
    assert.equal(strikeCount('session-dup'), 1, 'one strike from the duplicated entry, not two');
    assert.equal(
      auditEvents().filter((e) => e.event === 'deliver_target_resume_failed' && e.sessionId === 'session-dup').length,
      1,
      'the target is resumed exactly once per beat',
    );
    await beat(deps, 'interval');
    assert.equal(strikeCount('session-dup'), 2);
    await beat(deps, 'interval'); // third strike crosses the threshold
  } finally {
    resetRuntimeForTest();
  }
  assert.equal(
    loadBindings(guard, settingsDir).bindings.some((b) => b.sessionId === 'session-dup'),
    false,
    'three beats (three strikes) remove the binding, not two',
  );
  assert.equal(
    auditEvents().filter((e) => e.event === 'binding_auto_removed' && e.sessionId === 'session-dup').length,
    1,
  );
});

// ── N2: 池空不取图；idleMode 兜底仍要 screen ─────────────────────────────

/** A stub screen collector (screenpulse.ps1) that produces a VALID pulse with
 *  a shot: collectScreen encrypts it and stamps it as this beat's own, so the
 *  native vision path has a current picture to unlock (a pre-seeded shot would
 *  be dropped as stale by the real collect phase). Windows-only — the beat's
 *  probes are Windows-only by contract (ps.ts). */
function writeStubCollector(): string {
  const dir = path.join(sandbox, 'stub-assets');
  fs.mkdirSync(dir, { recursive: true });
  const jpeg1x1 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDs0NDX/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';
  fs.writeFileSync(path.join(dir, 'screenpulse.ps1'), [
    'param([string]$outdir, [int]$cap)',
    '$meta = [ordered]@{',
    "  title = 'stub'",
    "  process = 'stub.exe'",
    '  pid = 4242',
    '  rect = $null',
    '  screen = $null',
    "  focus = [ordered]@{ title = 'stub'; process = 'stub.exe'; pid = 4242 }",
    '  windows = @()',
    "  captured_at = (Get-Date).ToUniversalTime().ToString('o')",
    "  shot_path = (Join-Path $outdir 'screen.raw.jpg')",
    '}',
    // [IO.File]::WriteAllText = UTF-8 WITHOUT BOM (Set-Content -Encoding UTF8
    // on PS5.1 writes a BOM, and JSON.parse throws on it).
    "[IO.File]::WriteAllText((Join-Path $outdir 'screen.raw.json'), ($meta | ConvertTo-Json -Depth 5))",
    "[IO.File]::WriteAllBytes((Join-Path $outdir 'screen.raw.jpg'), [Convert]::FromBase64String('" + jpeg1x1 + "'))",
    'exit 0',
  ].join('\n'), 'utf8');
  return dir;
}


/** Home agent that answers a vision turn (image part) with a scene line and
 *  any other turn with the decision JSON; counts every followup — each one is
 *  a model round the beat spent. */
function countingVisionAgent(): { agent: Record<string, unknown>; followups: () => number } {
  let count = 0;
  const events: { type: string; data?: unknown }[] = [];
  const agent = {
    id: 'hb-home',
    session: { id: 'session-home', events, snapshotEvents: () => events },
    options: { model: 'test-model' },
    followup: (message: unknown) => {
      count += 1;
      const content = (message as { content?: { type?: string }[] }).content ?? [];
      const isVision = content.some((p) => p.type === 'image');
      events.push({
        type: 'assistant/message',
        data: { content: [{ type: 'text', text: isVision ? '在 IDE 里写测试' : '{"seed_ids":["s1"]}' }] },
      });
    },
    whenIdle: async () => {},
    cancel: () => {},
  };
  return { agent, followups: () => count };
}

const imageRefLike = { attachmentId: 'sha256:beat', mediaType: 'image/jpeg', bytes: 4, name: 'heartbeat-screen.jpg' };

test('beat: an empty pool spends no vision round and no model turn (N2)', async () => {
  // Pool empty + idleMode off → the beat goes silent BEFORE any picture is
  // taken. The stub collector hands the beat a CURRENT shot (the missing-assets
  // default never has one, so without it saves/followups would be 0 even under
  // the old vision-first order — empty assertions), and the services below
  // would let native vision run a full model round if that old call order
  // (vision → pool check) were still in place.
  let saves = 0;
  const counting = countingVisionAgent();
  const deps = makeHarness('session-nobody', counting.agent, {
    home: counting.agent,
    assetsDir: writeStubCollector(),
    services: {
      attachments: { saveImage: async () => { saves += 1; return imageRefLike; } },
      llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
    },
  });
  try {
    await beat(deps, 'interval');
  } finally {
    resetRuntimeForTest();
  }
  assert.equal(saves, 0, 'no picture was even unlocked/stored');
  assert.equal(counting.followups(), 0, 'no model round was spent');
  assert.equal(
    auditEvents().filter((e) => e.event === 'screen_vision').length,
    0,
    'no screen_vision audit: vision never ran',
  );
  assert.ok(auditEvents().some((e) => e.event === 'silent' && e.reason === 'no candidates'));
});

test('beat: the idleMode fallback is a speaking path and still gets its screen (N2)', async () => {
  // Pool empty, idleMode on, one profile topic → the fallback speaks, so the
  // vision round must happen (and must be audited). The stub collector gives
  // the beat a real current shot so native vision can actually succeed.
  const entry = {
    id: 'p1',
    partition: 'interest',
    topic: '游戏',
    subTopic: '新版本',
    content: '他在等新版本上线',
    confidence: 0.6,
    temporal: 'volatile',
    validFrom: new Date().toISOString(),
    validTo: null,
    supersededBy: null,
    evidence: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    updateCount: 1,
  };
  fs.writeFileSync(path.join(workspace().dataDir, 'profile.json'), JSON.stringify({
    version: 2,
    partitions: { interest: { entries: [entry] }, projects: { entries: [] }, comm: { entries: [] }, psy: { entries: [] } },
  }), 'utf8');
  const counting = countingVisionAgent();
  const deps = makeHarness('session-nobody', counting.agent, {
    home: counting.agent,
    idleMode: true,
    assetsDir: writeStubCollector(),
    services: {
      attachments: { saveImage: async () => imageRefLike },
      llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
    },
  });
  try {
    await beat(deps, 'interval');
  } finally {
    resetRuntimeForTest();
  }
  const sv = auditEvents().filter((e) => e.event === 'screen_vision');
  assert.equal(sv.length, 1, 'the fallback path still runs vision exactly once');
  assert.equal(sv[0]!.engine, 'native');
  assert.equal(sv[0]!.ok, true, 'the native read succeeded in the fallback path');
  assert.ok(auditEvents().some((e) => e.event === 'idle_fallback'));
  assert.ok(counting.followups() >= 2, 'vision turn + expression turn both ran');
});

// ── N8③/N4: the screen_vision audit names its engine (and the auto→modlens
//    line keeps the native failure reason). No screenshot in this harness, so
//    every engine fails fast on 'no screenshot this beat' — the audit line is
//    still written with its engine field, which is exactly what is pinned.

test('beat: screen_vision audit carries the engine — native, modlens, and auto→modlens (N8/N4)', async () => {
  seedPool();
  const nobody = () => stubAgent('hb-home', { id: 'session-home', events: [], snapshotEvents: () => [] });
  // engine=native: the audit line names native even when the read fails.
  let deps = makeHarness('session-nobody', nobody(), { visionEngine: 'native' });
  try {
    await beat(deps, 'interval');
  } finally {
    resetRuntimeForTest();
  }
  // engine=modlens: the pinned engine names itself, native is never tried.
  deps = makeHarness('session-nobody', nobody(), { visionEngine: 'modlens' });
  try {
    await beat(deps, 'interval');
  } finally {
    resetRuntimeForTest();
  }
  // auto: native fails first, ModLens answers — the engine field says modlens
  // AND the line keeps WHY native failed (N4), so a native-only problem is
  // visible in the audit without re-running anything.
  deps = makeHarness('session-nobody', nobody(), {});
  try {
    await beat(deps, 'interval');
  } finally {
    resetRuntimeForTest();
  }
  // One sandbox for all three beats: the audit file accumulates, so assert the
  // THREE lines as one ordered list.
  const sv = auditEvents().filter((e) => e.event === 'screen_vision');
  assert.deepEqual(sv.map((e) => e.engine), ['native', 'modlens', 'modlens']);
  assert.equal(sv[0]!.ok, false);
  assert.match(sv[0]!.error!, /no screenshot/);
  assert.equal(sv[2]!.ok, false);
  assert.equal(sv[2]!.nativeError, 'no screenshot this beat', 'the native failure reason rides along (N4)');
  assert.equal(sv[1]!.nativeError, undefined, 'engine=modlens has no native attempt, hence no nativeError');
});

// ── N18 rework 中1/中2: the beat boundary books by the SIGNAL, not the error
//    class. A phase that rejects with a plain Error while the beat's signal is
//    dying used to land in the beat_error branch — logger.error, lastBeat
//    'error' on the settings card, even markHomeRotateIfOverflow on the error
//    text — and the aborted vision read still wrote a screen_vision ok:false
//    line.
//
//    Constructibility note (reviewer-approved 2026-11-18): a modlens-engine
//    beat-level abort case cannot be built in this environment —
//    @liustack/modlens is not installed, so resolveModlensMain returns null and
//    describeScreenShot early-returns fully SYNCHRONOUSLY (no await window for
//    an abort to land in), while a beat's controller can only be aborted by the
//    watchdog, phase ceilings (minutes), or the orchestrator disposer — never
//    by a fake that only holds the AbortSignal (signals are not externally
//    abortable). The modlens-path coverage therefore lives in the unit tests
//    (vision-native.test.ts: the modlens-catch rethrow and the native-ordering
//    case), and the beat-level coverage below uses the disposer as the abort
//    vehicle on the auto path.
//
//    A6 低3 (reviewer-confirmed wording): the stage='unknown' expected below
//    pins the NATIVE modality probe's plain-Error rethrow — NOT the modlens
//    path. That classless error is deliberate: it is what keeps the 低4 error
//    text on the beat_aborted line. The modlens aborts now raise a real
//    BeatAbortedError('vision'); their class/stage/scrub pins live in
//    vision-native.test.ts («modlens: a spawn rejection quoting the shot path…»).

test('beat: a plain-error failure while the signal aborts is beat_aborted, not beat_error (N18 rework 中1/中2)', async () => {
  // Beat 1 (empty pool): a healthy silent beat, so the settings card holds a
  // real verdict before the aborting beat runs.
  let deps = makeHarness('session-nobody', stubAgent('hb-home', { id: 'session-home', events: [], snapshotEvents: () => [] }));
  try {
    await beat(deps, 'interval');
  } finally {
    resetRuntimeForTest();
  }
  assert.equal(getLastBeat()?.verdict, 'silent', 'precondition: the card holds the healthy beat');
  resetHomeAgent(); // drop beat 1's cached home — beat 2 needs the probe-enabled agent

  // Beat 2: the abort comes from the production disposer (the host's teardown
  // is the only thing outside the beat that aborts the beat's controller —
  // startOrchestrator is started solely to capture it; in the sandbox
  // notify.ps1 does not exist, so its ensureRegistered spawn fails fast with no
  // machine side effects). The fake modality probe parks mid-vision, the
  // disposer aborts the controller, then the probe rejects with a PLAIN Error:
  // the signal — not the error class — must decide the booking.
  seedPool();
  const events: { type: string; data?: unknown }[] = [];
  const agent = {
    id: 'hb-home',
    session: { id: 'session-home', events, snapshotEvents: () => events },
    options: { provider: 'test-provider', model: 'test-model' },
    followup: () => {
      events.push({ type: 'assistant/message', data: { content: [{ type: 'text', text: '{"seed_ids":["s1"]}' }] } });
    },
    whenIdle: async () => {},
    cancel: () => {},
  };
  let releaseProbe: ((e: Error) => void) | null = null;
  let disposeOrchestrator: (() => void) | null = null;
  const probeParked = new Promise<void>((resolve) => {
    deps = makeHarness('session-nobody', agent, {
      home: agent,
      assetsDir: writeStubCollector(),
      onEffect: (teardown) => { disposeOrchestrator = teardown; },
      services: {
        attachments: { saveImage: async () => imageRefLike },
        llm: {
          resolveModelInfo: () => new Promise<never>((_resolve, reject) => {
            releaseProbe = (e) => reject(e);
            resolve();
          }),
        },
      },
    });
  });
  try {
    startOrchestrator(deps);
    const p = beat(deps, 'interval');
    await within(probeParked, 'the vision modality probe to park'); // vision is now parked inside the modality probe
    disposeOrchestrator!(); // the host teardown: aborts the beat's controller
    releaseProbe!(new Error('registry exploded mid-abort'));
    await within(p, 'the aborted beat to settle');
  } finally {
    // A6 中1: the disposer is the ONLY cleaner of the 20-minute interval chain
    // and the 15s startup timer. Without it an early failure here kept the test
    // process alive for two minutes and let the startup beat run inside the
    // NEXT test (old sandbox + new runtime = cross-test pollution).
    (disposeOrchestrator as (() => void) | null)?.();
    resetRuntimeForTest();
    resetHomeAgent();
  }
  const audit = auditEvents();
  const aborted = audit.filter((e) => e.event === 'beat_aborted');
  assert.equal(aborted.length, 1, 'the beat was booked as cancelled exactly once');
  // A6 低1 (measured 2026-11-18, mutation table in the header): this absence is
  // a LATE red. Making screen_vision appear at all needs FIVE deletions —
  //   (1) describeScreenShotNative's catch rethrow,
  //   (2) the router's abort check before the engine==='native' return,
  //   (3) viaModlens' entry check,
  //   (4) modlensFailure's abort throw (hit here by 'modlens not installed'),
  //   (5) viaModlens' post-call abort check —
  // and only then does the beat close without a vision cancellation (the later
  // decision-turn ceiling still books beat_aborted, so the count above stays
  // green and THIS assertion is the first red). With only (1)(2)(3) removed the
  // beat is still aborted by (4) — now as BeatAbortedError('vision') — so the
  // first red there is the stage assertion two lines down ('vision' ≠
  // 'unknown'): measured, not assumed. Restore = green.
  assert.equal(
    audit.find((e) => e.event === 'screen_vision'),
    undefined,
    'the aborted vision read must not surface as screen_vision ok:false',
  );
  // A6 低3 note: this abort is the NATIVE probe's plain-Error rethrow, so the
  // boundary still fills 'unknown' here (the error text below is what 低4 pins).
  // The modlens-side abort now carries BeatAbortedError(stage 'vision') — its
  // pin lives in vision-native.test.ts (modlens spawn rejection / CLI exit /
  // dead-signal success cases).
  assert.equal(aborted[0]!.stage, 'unknown', 'a plain Error has no stage — the boundary fills "unknown"');
  assert.equal(aborted[0]!.why, 'orchestrator disposed', 'why comes from abortText(signal)');
  assert.match(
    aborted[0]!.error!,
    /registry exploded mid-abort/,
    '低4: a rethrow-style abort keeps the error text for traceability',
  );
  assert.equal(
    audit.find((e) => e.event === 'beat_error'),
    undefined,
    'a cancellation must not be booked as beat_error',
  );
  // a4 ②(dead-assertion fix): the disposer clears the card by design (H-02),
  // so `verdict` is null/undefined here — the old notEqual('error') was
  // vacuously true. Pin the actual state: no verdict at all was written for
  // the aborting beat.
  assert.equal(getLastBeat()?.verdict ?? null, null, 'the aborting beat wrote no verdict — the disposer cleared the card');
});

// ── N18-a3 中2: the four turn-level catches (decision / expression / weekly /
//    observe) used to swallow a cancellation into their deferred/silent
//    bookings — a cancelled beat closed normally with status written and not a
//    single beat_aborted line. The disposer vehicle parks the DECISION turn
//    (the beat's biggest time sink) mid-whenIdle; the beat must unwind as
//    cancelled, not as an ordinary silence.

test('beat: an abort landing in the decision turn unwinds as beat_aborted, not decision_deferred (N18-a3 中2)', async () => {
  let resolveDecisionParked!: () => void;
  const decisionParked = new Promise<void>((resolve) => { resolveDecisionParked = resolve; });
  let disposeOrchestrator: (() => void) | null = null;
  seedPool();
  const events: { type: string; data?: unknown }[] = [];
  let followups = 0;
  let whenIdleCalls = 0;
  const agent = {
    id: 'hb-home',
    session: { id: 'session-home', events, snapshotEvents: () => events },
    options: { provider: 'test-provider', model: 'test-model' },
    followup: () => {
      events.push({ type: 'assistant/message', data: { content: [{ type: 'text', text: '{"seed_ids":["s1"]}' }] } });
      followups += 1;
      // turn 1 is the vision turn; only when the DECISION turn's followup has
      // fired is the abort allowed to land (it must hit the decision turn).
      if (followups >= 2) resolveDecisionParked();
    },
    whenIdle: () => {
      whenIdleCalls += 1;
      return whenIdleCalls === 1
        ? Promise.resolve() // the vision turn settles
        : new Promise<void>(() => {}); // the decision turn parks forever
    },
    cancel: () => {},
  };
  const deps = makeHarness('session-nobody', agent, {
    home: agent,
    assetsDir: writeStubCollector(),
    onEffect: (teardown) => { disposeOrchestrator = teardown; },
    services: {
      attachments: { saveImage: async () => imageRefLike },
      llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
    },
  });
  try {
    startOrchestrator(deps); // capture the real teardown (same vehicle as ②)
    const p = beat(deps, 'interval');
    await within(decisionParked, 'the decision turn to park'); // the decision turn is parked in its whenIdle await
    disposeOrchestrator!(); // abort 'orchestrator disposed' lands mid-turn
    await within(p, 'the aborted beat to settle');
  } finally {
    // A6 中1: same disposer fallback as ② — the timers this teardown clears are
    // the difference between "test fails" and "process hangs for 120s".
    (disposeOrchestrator as (() => void) | null)?.();
    resetRuntimeForTest();
    resetHomeAgent();
  }
  const audit = auditEvents();
  const aborted = audit.filter((e) => e.event === 'beat_aborted');
  assert.equal(aborted.length, 1, 'the cancellation reached the beat boundary exactly once');
  assert.equal(aborted[0]!.stage, 'decision', 'the abort names the stage it landed in');
  assert.equal(aborted[0]!.why, 'orchestrator disposed');
  assert.equal(
    audit.find((e) => e.event === 'decision_deferred'),
    undefined,
    'a cancellation must not be booked as decision_deferred',
  );
  assert.equal(
    audit.find((e) => e.event === 'beat_error'),
    undefined,
    'a cancellation must not be booked as beat_error',
  );
});

test('beat: an abort landing in the weekly turn unwinds as beat_aborted, not a template report (N18-a4 weekly rethrow)', async () => {
  // Pins BOTH weekly catch rethrows with one scenario:
  //   - inner (weekly turn catch): deleting it books weekly_llm_failed and
  //     falls through to the deterministic template report;
  //   - outer (weeklyPhase catch): deleting it books weekly_failed and swallows
  //     the cancellation entirely (no beat_aborted at all).
  // Vehicle is the same disposer teardown as the 中2 decision test: the beat
  // parks in the weekly turn's whenIdle await, the teardown aborts the ctl,
  // and withTimeout rejects the turn with a BeatAbortedError(stage 'weekly').
  let disposeOrchestrator: (() => void) | null = null;
  let whenIdleCalls = 0;
  let resolveWeeklyTurnStarted!: () => void;
  const weeklyTurnStarted = new Promise<void>((resolve) => { resolveWeeklyTurnStarted = resolve; });
  const agent = {
    id: 'hb-home',
    session: { id: 'session-home', events: [], snapshotEvents: () => [] },
    options: { provider: 'test-provider', model: 'test-model' },
    followup: () => {},
    whenIdle: () => {
      whenIdleCalls += 1;
      if (whenIdleCalls === 1) {
        // the weekly turn is the FIRST engine-room turn of this beat
        // (maintenance makes none; collect/wander/expression come after it)
        resolveWeeklyTurnStarted();
        return new Promise<void>(() => {}); // park until the abort unwinds it
      }
      return Promise.resolve();
    },
    cancel: () => {},
  };
  // The store says the last report was generated 8 days ago → weeklyDue, and
  // ensureWeeklyAnchor must NOT re-anchor (lastGeneratedAt > 0).
  fs.mkdirSync(path.join(workspace().dataDir, 'weekly'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace().dataDir, 'weekly', 'state.json'),
    JSON.stringify({ lastGeneratedAt: Date.now() - 8 * 86_400_000 }),
    'utf8',
  );
  const deps = makeHarness('session-nobody', agent, {
    home: agent, // the weekly turn runs on the HOME agent, not a bound one
    weekly: true,
    onEffect: (teardown) => { disposeOrchestrator = teardown; },
  });
  try {
    startOrchestrator(deps); // capture the real teardown (same vehicle as ②)
    const p = beat(deps, 'interval');
    await within(weeklyTurnStarted, 'the weekly turn to park'); // the weekly turn is parked in its whenIdle await
    disposeOrchestrator!(); // abort 'orchestrator disposed' lands mid-weekly-turn
    await within(p, 'the aborted beat to settle');
  } finally {
    // a4 ⑥: a mid-test failure must not leave the beat flying — dispose is
    // idempotent after a settled beat (abort on a dead controller is a no-op).
    (disposeOrchestrator as (() => void) | null)?.();
    resetRuntimeForTest();
    resetHomeAgent();
  }
  const audit = auditEvents();
  const aborted = audit.filter((e) => e.event === 'beat_aborted');
  assert.equal(aborted.length, 1, 'the cancellation reached the beat boundary exactly once');
  assert.equal(aborted[0]!.stage, 'weekly', 'the abort names the stage it landed in');
  assert.equal(aborted[0]!.why, 'orchestrator disposed');
  assert.equal(
    audit.find((e) => e.event === 'weekly_llm_failed'),
    undefined,
    'a cancelled weekly turn must not be booked as weekly_llm_failed (inner rethrow)',
  );
  assert.equal(
    audit.find((e) => e.event === 'weekly_failed'),
    undefined,
    'a cancelled weekly turn must not be booked as weekly_failed (outer rethrow)',
  );
  assert.equal(
    audit.find((e) => e.event === 'weekly_generated'),
    undefined,
    'a cancelled weekly turn must not fall through to the template report',
  );
  assert.equal(
    audit.find((e) => e.event === 'beat_error'),
    undefined,
    'a cancellation must not be booked as beat_error',
  );
});

test('beat: an abort landing in the observe read path unwinds as beat_aborted, not observe_error (N18-a4 observe rethrow)', async () => {
  // Pins the per-binding observe catch rethrow: the read path (touching the
  // bound session) throws WHILE the signal is dying — the getter aborts the
  // beat via the real disposer teardown first, then explodes — so the catch
  // must see a dying signal and rethrow instead of booking observe_error.
  let disposeOrchestrator: (() => void) | null = null;
  const bound = {
    id: 'agent-obs',
    get session() {
      if (disposeOrchestrator) disposeOrchestrator(); // abort 'orchestrator disposed' lands first
      throw new Error('session log exploded mid-abort');
    },
    options: { model: 'test-model' },
    followup: () => {},
    whenIdle: async () => {},
    cancel: () => {},
  };
  addBinding(guard, workspace().settingsDir, 'session-obs', { deliver: true, observe: true });
  const deps = makeHarness('session-obs', bound, {
    onEffect: (teardown) => { disposeOrchestrator = teardown; },
  });
  try {
    startOrchestrator(deps);
    await within(beat(deps, 'interval'), 'the observe beat to settle');
  } finally {
    // a4 ⑥: same flying-beat guard as the weekly case.
    (disposeOrchestrator as (() => void) | null)?.();
    resetRuntimeForTest();
    resetHomeAgent();
  }
  const audit = auditEvents();
  const aborted = audit.filter((e) => e.event === 'beat_aborted');
  assert.equal(aborted.length, 1, 'the cancellation reached the beat boundary exactly once');
  assert.equal(aborted[0]!.why, 'orchestrator disposed');
  // No 低4 error-field assertion here, deliberately: the boundary sees the
  // BeatAbortedError('collect') that withTimeout's guard rejects at abort
  // time — it always wins the race over the rethrow-style plain error, which
  // still has await frames to bubble through. 低4's error field is pinned by
  // the ② test ('registry exploded mid-abort'), where the abort vehicle is a
  // plain-Error rejection with no withTimeout guard in between. The pin HERE
  // is observe_error's absence: delete the per-binding rethrow and this row
  // appears (the catch treats a dying signal as an observation failure).
  assert.equal(
    audit.find((e) => e.event === 'observe_error'),
    undefined,
    'a cancellation must not be booked as observe_error',
  );
  assert.equal(
    audit.find((e) => e.event === 'beat_error'),
    undefined,
    'a cancellation must not be booked as beat_error',
  );
});

test('beat: an abort landing in the spoken (expression) turn unwinds as beat_aborted, not spoke_deferred (N18-a4 expression rethrow, A9)', async () => {
  // Pins the deliverPackage expression-turn catch rethrow (the A9 line). The
  // a3 review believed some other full-suite test went red under this
  // mutation; empirically it does not (M15 probe: 641 pass / 0 fail with the
  // rethrow deleted — the causes[1] pin in vision-native.test.ts is a
  // nativeVisionTurn UNIT test and never reaches this catch). So this beat
  // case IS the coverage source now; same disposer vehicle as the weekly case.
  // Fixture = the idleMode fallback (its speak path reuses deliverPackage).
  let disposeOrchestrator: (() => void) | null = null;
  let resolveSpokenTurnStarted!: () => void;
  const spokenTurnStarted = new Promise<void>((resolve) => { resolveSpokenTurnStarted = resolve; });
  const events: { type: string; data?: unknown }[] = [];
  let spokenPending = false;
  const agent = {
    id: 'hb-home',
    session: { id: 'session-home', events, snapshotEvents: () => events },
    options: { model: 'test-model' },
    followup: (message: unknown) => {
      const content = (message as { content?: { type?: string }[] }).content ?? [];
      if (content.some((p) => p.type === 'image')) {
        // the vision turn settles with a screen summary
        events.push({ type: 'assistant/message', data: { content: [{ type: 'text', text: '在 IDE 里写测试' }] } });
        return;
      }
      // agentTurn's prompt message names its phase in source.sections[0].text —
      // park only when the SPOKEN turn's package lands, before any assistant
      // text exists (so the swallow path finds no late text either).
      const label = (message as { source?: { sections?: { text?: string }[] } }).source?.sections?.[0]?.text;
      if (label === 'expression') {
        spokenPending = true;
        resolveSpokenTurnStarted();
      }
    },
    whenIdle: () => (spokenPending ? new Promise<void>(() => {}) : Promise.resolve()),
    cancel: () => {},
  };
  // idleMode fallback fixture: pool empty, one profile topic to speak.
  const entry = {
    id: 'p1',
    partition: 'interest',
    topic: '游戏',
    subTopic: '新版本',
    content: '他在等新版本上线',
    confidence: 0.6,
    temporal: 'volatile',
    validFrom: new Date().toISOString(),
    validTo: null,
    supersededBy: null,
    evidence: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    updateCount: 1,
  };
  fs.writeFileSync(path.join(workspace().dataDir, 'profile.json'), JSON.stringify({
    version: 2,
    partitions: { interest: { entries: [entry] }, projects: { entries: [] }, comm: { entries: [] }, psy: { entries: [] } },
  }), 'utf8');
  const deps = makeHarness('session-nobody', agent, {
    home: agent,
    idleMode: true,
    assetsDir: writeStubCollector(),
    services: {
      attachments: { saveImage: async () => imageRefLike },
      llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
    },
    onEffect: (teardown) => { disposeOrchestrator = teardown; },
  });
  try {
    startOrchestrator(deps); // capture the real teardown (same vehicle as ②)
    const p = beat(deps, 'interval');
    await within(spokenTurnStarted, 'the spoken turn to park'); // the spoken turn is parked in its whenIdle await
    disposeOrchestrator!(); // abort 'orchestrator disposed' lands mid-spoken-turn
    await within(p, 'the aborted beat to settle');
  } finally {
    // a4 ⑥: same flying-beat guard as the weekly case.
    (disposeOrchestrator as (() => void) | null)?.();
    resetRuntimeForTest();
    resetHomeAgent();
  }
  const audit = auditEvents();
  const aborted = audit.filter((e) => e.event === 'beat_aborted');
  assert.equal(aborted.length, 1, 'the cancellation reached the beat boundary exactly once');
  assert.equal(aborted[0]!.stage, 'expression', 'the abort names the stage it landed in');
  assert.equal(aborted[0]!.why, 'orchestrator disposed');
  assert.equal(
    audit.find((e) => e.event === 'spoke_deferred'),
    undefined,
    'a cancellation must not be booked as spoke_deferred',
  );
  assert.equal(
    audit.find((e) => e.event === 'spoke_late'),
    undefined,
    'a cancellation must not take the late-text confirm path either',
  );
  assert.equal(
    audit.find((e) => e.event === 'beat_error'),
    undefined,
    'a cancellation must not be booked as beat_error',
  );
});

// ── B2 rework a2 测试洞 3 (2.3.0): the suffix wiring through the REAL path ─
// silentAuditLine's unit tests only ever pass explicit booleans, so the
// noConclude wiring inside deliverPackage was never asserted — the a2 snapshot
// defect (the conclude flag was cleared before the silent booking read it,
// suffixing the conclude path) slipped through exactly there. These two cases
// run a REAL beat (decision turn → deliverPackage → agentTurn → the real
// seed_report tool via the model's followup) and assert the audit lines the
// beat actually writes. Only new cases + a local harness copy; existing
// fixtures and assertions are untouched.

/** Bound agent whose expression turn ends `completed`. `report` makes the
 *  model call the REAL seed_report tool — with the conclude switch on and a
 *  silent report answering the live package, the tool requests concludeTurn
 *  and report.ts marks the per-turn flag. `speak` gives the turn real body
 *  text (the spoke path). `whenIdle` awaits the tool run so the flag/report
 *  are settled before agentTurn's gate reads them. */
function silentConcludeAgent(opts: { speak?: boolean; report?: boolean } = {}): Record<string, unknown> {
  const events: { type: string; data?: unknown }[] = [];
  let toolRun: Promise<unknown> = Promise.resolve();
  // B2 rework a3 低3: the tool's conclude switch is wired EXACTLY like the
  // production entry (src/index.ts:537) — through the LIVE runtime flag, not a
  // hardcoded true. beat① (harness ON) and beat② (harness OFF) therefore
  // exercise both branches through the runtime: reverting this to `() => true`
  // makes beat② RED (its tool would conclude despite the switch being off →
  // wasConcludeRequested() ends up true).
  const tool = buildSeedReportTool(
    guard,
    reportFilePath(workspace().dataDir),
    () => getRuntime().flags.concludeSilentTurn?.() === true,
    // wired like index.ts's auditReportLine — the conclude audit must reach
    // the same heartbeat.jsonl the beat's assertions read
    (e) => { try { appendAuditLine(workspace().logsDir + '/heartbeat.jsonl', e); } catch { /* audit must never fail the tool */ } },
    () => getCurrentDeliveryId(),
  ) as { execute(args: unknown, exec?: unknown): Promise<unknown> };
  return {
    id: 'agent-silent',
    session: { id: 'session-silent', events, snapshotEvents: () => events },
    options: { model: 'test-model' },
    followup: () => {
      const did = getCurrentDeliveryId();
      if (did && opts.report) {
        toolRun = tool.execute({ spoken: 'silent', reason: '不想说话', delivery_id: did }, { concludeTurn: () => {} });
      }
      if (opts.speak) {
        events.push({ type: 'assistant/message', data: { content: [{ type: 'text', text: '说到咖啡，我最近也在喝' }] } });
      }
      events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
    },
    whenIdle: async () => { await toolRun; },
    cancel: () => {},
  };
}

/** Local copy of makeDeliveryHarness with the concludeSilentTurn flag wired
 *  (the shared harness has no conclude flag and must stay untouched). */
function makeConcludeHarness(
  boundId: string,
  home: Record<string, unknown>,
  boundAgent: Record<string, unknown>,
  concludeOn: boolean,
): OrchestratorDeps {
  const paths = { ...workspace(), assetsDir: path.join(sandbox, 'missing-assets') };
  fs.mkdirSync(paths.settingsDir, { recursive: true });
  fs.writeFileSync(path.join(paths.settingsDir, 'interests.json'), '{"interests":[],"_schedule":{}}', 'utf8');
  const homeId = (home.session as { id: string }).id;
  const ctx = {
    agents: {
      create: async () => ({ agent: home }),
      resume: async (req: { resumeSessionId?: string }) =>
        req.resumeSessionId === boundId ? { agent: boundAgent } : { agent: home },
      roots: () => [],
      get: (id: string) => (id === boundId ? undefined : id === homeId ? home : undefined),
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (fn: () => unknown) => { fn(); return () => {}; },
  };
  const deps = { ctx, paths, guard, policy: POLICY } as unknown as OrchestratorDeps;
  setRuntime({
    paths,
    guard,
    policy: POLICY,
    flags: {
      statusbarEnabled: () => false,
      timeInjectMin: () => 0,
      idleMode: () => false,
      tokenSaver: () => false,
      visionEngine: () => '',
      concludeSilentTurn: () => concludeOn,
    },
  });
  return deps;
}

function silentLine(events: { event: string; reason?: string }[]): { reason?: string } | undefined {
  return events.find((e) => e.event === 'silent');
}

test('beat ①: switch ON + a REAL conclude + completed + empty body — the silent line stays unsuffixed', async () => {
  // The conclude path: switch on, the model filed a silent report and the tool
  // really requested concludeTurn (flag set through report.ts). agentTurn
  // writes turn_concluded (no fault line), so the silent reason must NOT
  // carry 「（回合无输出）」 — under the a2 pre-fix code (flag cleared before
  // this booking read it) the suffix appeared here and this case goes RED.
  seedPool();
  addBinding(guard, workspace().settingsDir, 'session-silent', { deliver: true, observe: false });
  const bound = silentConcludeAgent({ report: true });
  const deps = makeConcludeHarness('session-silent', decisionAgent(), bound, true);

  try {
    await beat(deps, 'interval');
  } finally {
    resetRuntimeForTest();
  }

  const events = auditEvents();
  const silent = silentLine(events);
  assert.ok(silent, 'the beat filed a silent line: ' + JSON.stringify(events.map((e) => e.event)));
  assert.ok(!silent!.reason!.includes('（回合无输出）'),
    `the conclude path stays unsuffixed, got: ${silent!.reason}`);
  assert.ok(events.some((e) => e.event === 'turn_concluded'), 'the conclude was audited');
  assert.equal(events.some((e) => e.event === 'turn_extraction_empty'), false, 'no fault line on the conclude path');
});

test('beat ②: switch OFF + completed + empty body — suffix rides the silent line AND the fault line co-occurs', async () => {
  // The unconcluded path: switch off (no conclude possible), zero text,
  // completed end — turn_extraction_empty and the silent line co-occur, and
  // the suffix marks it. Force `noConclude` to false in deliverPackage and
  // this goes RED (suffix missing).
  seedPool();
  addBinding(guard, workspace().settingsDir, 'session-silent', { deliver: true, observe: false });
  // switch OFF: the tool still files the report but never concludes
  const bound = silentConcludeAgent({ report: true });
  const deps = makeConcludeHarness('session-silent', decisionAgent(), bound, false);

  try {
    await beat(deps, 'interval');
  } finally {
    resetRuntimeForTest();
  }

  const events = auditEvents();
  const silent = silentLine(events);
  assert.ok(silent, 'the beat filed a silent line: ' + JSON.stringify(events.map((e) => e.event)));
  assert.ok(silent!.reason!.includes('（回合无输出）'),
    `the unconcluded path is suffixed, got: ${silent!.reason}`);
  assert.ok(events.some((e) => e.event === 'turn_extraction_empty'),
    'the fault line co-occurs with the suffixed silent line');
  assert.equal(events.some((e) => e.event === 'turn_concluded'), false,
    'switch off: no conclude was requested, nothing is renamed');
  assert.equal(wasConcludeRequested(), false, 'no conclude happened in this beat');
  // a3 低3: the tool's conclude switch must come from the runtime (the
  // production wiring at src/index.ts:537) — with the switch OFF the tool
  // must never request a conclude, however it is wired. Reverting the test
  // wiring to a hardcoded `() => true` puts conclude_silent_requested in the
  // audit (the end-of-beat flag reset hides it from the flag alone).
  assert.equal(
    auditEvents().some((e) => e.event === 'conclude_silent_requested'), false,
    'switch off: no conclude request may be audited',
  );
});

// ── B2 rework a3 中1 (2.3.0): the early clear / beat-start reset are SECURITY
// properties now — the cross-review (bc17406d) replayed seed_report with a
// captured id during the sendNewMessageHint spawn await and showed that
// WITHOUT the early clear a user's normal chat turn gets concluded. Both
// guards below get a red-able beat-level case.

test('beat ③: a seed_report replayed with the captured id in the hint window is REJECTED (the early clear guards the user window)', async () => {
  // The model speaks (no report) — the spoke path books the delivery, then
  // awaits sendNewMessageHint's real spawn. During that window a replayed
  // seed_report with the id captured while the turn was open must be turned
  // away: the early clear (right after agentTurn) already wiped the id.
  // Delete the early clear (orchestrator.ts ~:2049-2050) and this goes RED:
  // the replay lands ok:true + 「回合收尾:已结束」 and audits
  // conclude_silent_requested — the user's chat turn concluded by a stale
  // package id.
  seedPool();
  addBinding(guard, workspace().settingsDir, 'session-silent', { deliver: true, observe: false });
  const bound = silentConcludeAgent({ speak: true });
  const deps = makeConcludeHarness('session-silent', decisionAgent(), bound, true);

  // Capture the id while the delivery turn is open, then replay the tool the
  // moment the spoke booking exists (confirmSend lands right before the hint
  // await — a real powershell spawn, so the window is wide enough to be
  // deterministic at a 5ms poll).
  let captured = '';
  let fired = false;
  let replay: { ok: boolean; message: string } | null = null;
  const replayTool = buildSeedReportTool(
    guard, reportFilePath(workspace().dataDir), () => true, undefined, () => getCurrentDeliveryId(),
  ) as { execute(args: unknown, exec?: unknown): Promise<{ ok: boolean; message: string }> };
  const poll = setInterval(() => {
    if (!captured) {
      const cur = getCurrentDeliveryId();
      if (cur) captured = cur;
      return;
    }
    if (!fired && fs.existsSync(sentFilePath(workspace()))) {
      fired = true;
      clearInterval(poll);
      void replayTool
        .execute({ spoken: 'silent', reason: '不想说话', delivery_id: captured }, { concludeTurn: () => {} })
        .then((r) => { replay = r; });
    }
  }, 5);

  try {
    await beat(deps, 'interval');
  } finally {
    clearInterval(poll);
    resetRuntimeForTest();
  }
  // give the in-flight replay a moment to settle if it raced the beat's end
  for (let i = 0; !replay && i < 100; i++) await new Promise((r) => setTimeout(r, 50));

  assert.ok(captured, 'the delivery id was captured while the turn was open');
  const result = replay as { ok: boolean; message: string } | null;
  assert.ok(result, 'the replay actually fired during the hint window');
  assert.equal(result!.ok, false, `the replayed report must be rejected, got: ${JSON.stringify(result)}`);
  assert.ok(result!.message.includes('与当前投递包不符'), result!.message);
  assert.equal(wasConcludeRequested(), false, 'nothing concluded the beat');
  assert.equal(
    auditEvents().some((e) => e.event === 'conclude_silent_requested'), false,
    'no conclude was smuggled through the replayed id',
  );
});

test('beat ④: a flag left by the PREVIOUS beat does not conclude this one (the beat-start reset)', async () => {
  // Simulate a stale flag surviving into a new beat (crash between set and
  // clear, watchdog overlap…): markConcludeRequested() BEFORE the beat, agent
  // ends completed with zero text and no report. The beat-start reset
  // (orchestrator.ts ~:1995) must wipe it — otherwise the agentTurn gate sees
  // switch ON + expression + completed + a flag it never earned and renames
  // the fault into turn_concluded. Remove the beat-start resetConcludeRequested()
  // and this goes RED.
  seedPool();
  addBinding(guard, workspace().settingsDir, 'session-silent', { deliver: true, observe: false });
  markConcludeRequested(); // the "previous beat"'s leftover
  const bound = silentConcludeAgent({}); // zero text, no report, completed end
  const deps = makeConcludeHarness('session-silent', decisionAgent(), bound, true);

  try {
    await beat(deps, 'interval');
  } finally {
    resetRuntimeForTest();
  }

  const events = auditEvents();
  assert.ok(events.some((e) => e.event === 'turn_extraction_empty'),
    'this beat keeps its honest fault line: ' + JSON.stringify(events.map((e) => e.event)));
  assert.equal(events.some((e) => e.event === 'turn_concluded'), false,
    'a flag this beat never earned must not rename the end into a conclusion');
});
