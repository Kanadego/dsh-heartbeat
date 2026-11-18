// B2 a5 (2.3.0): 低3 真实接线测试 — apply() 入口到 concludeSilentTurnRef 的
// 三段链路（ui.json → ref → seed_report 工具）此前只有 runtime getter 的单元
// 钉（session-gate-beat），评审实测把 index.ts:537 改成 ()=>false 全量假绿。
// 本文件用最小 fake ctx 跑一次真 apply()：
//   ① ui.concludeSilentTurn=true 启动 → runtime getter 读到 true；
//   ② 走 config.set 的 merged 回写路径（index.ts uiSet）→ getter 跟随变化；
//   ③ apply 注册的 seed_report 工具（:537 同一闭包）随开关透传：
//      开=concludeTurn 被调 + conclude_silent_requested 审计；关=不 conclude。
// 变异验收：:537 改 ()=>false → ③开分支红；uiSet 不回写 ref → ②红。
// 沙箱：目录经 tests/_sandbox.ts 的 sandboxDir('hb-wiring-') 创建；after() 里
// 显式 rmSync 自己的沙箱（幂等、ENOENT 忽略），_sandbox.ts 的 process-exit
// 钩子保留作兜底（进程被强杀时 after 跑不到）。文件末尾的 meta 用例是这层
// 卫生的回归守卫：子进程跑本文件后退出，父进程断言它建的沙箱目录已消失——
// 把下面创建 dataDir 的 sandboxDir('hb-wiring-') 换回裸 fs.mkdtempSync，meta 用例变红。
// 「apply 前写好 ui.json」与复用不冲突：sandboxDir 只建目录并返回路径，
// before() 里先写 ui.json 再 apply 即可。它只托管 DSH_HOME、不管
// HEARTBEAT_DATA_DIR，所以这个 env 的原值恢复由本文件 after() 负责——
// 原来是 undefined 就 delete，原来有值就还原，不能一律 delete；after 末尾
// 断言恢复结果（删掉恢复逻辑 → 断言红）。
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sandboxDir } from './_sandbox.js';
import { apply } from '../src/index.js';
import { initWorkspace, resetWorkspaceForTest } from '../src/core/paths.js';
import { getRuntime, resetRuntimeForTest, setCurrentDeliveryId } from '../src/core/runtime.js';
import { resetConcludeRequested } from '../src/seeds/report.js';
import { RPC_ROUTE_PATH } from '../src/rpc.js';

const dataDir = sandboxDir('hb-wiring-');
// meta 用例的子进程把沙箱路径经这个 env 回报给父进程；父进程只在自己 spawn
// 的环境对象里设置它，不会写进本进程的 env。
const metaReportPath = process.env.HB_WIRING_META_REPORT;
if (metaReportPath) fs.writeFileSync(metaReportPath, dataDir, 'utf8');
// initWorkspace 的 env 优先于 config.dataDir —— 两处指向同一个临时目录，双保险。
const originalDataDirEnv = process.env.HEARTBEAT_DATA_DIR;
process.env.HEARTBEAT_DATA_DIR = dataDir;

// --test-isolation=none 下同进程的 sibling 文件会在用例之间改写 env 与
// workspace()/runtime 单例（ui-config 的 beforeEach 就这么干）。每个用例
// 开头把本文件的沙箱重新钉回去，用例体才在自家目录上跑。
const pinSandbox = (): void => {
  process.env.HEARTBEAT_DATA_DIR = dataDir;
  resetWorkspaceForTest();
  initWorkspace({ dataDir });
};

beforeEach(pinSandbox);

after(() => {
  // meta 子进程模式故意跳过字面清理：父进程要验证的是「沙箱注册进 _sandbox
  // 的进程退出钩子」这条真正的卫生路径，而不是 after 的兜底——这样把上面
  // 的 sandboxDir 换回裸 fs.mkdtempSync 时，父进程才能看到残留目录。
  if (process.env.HB_WIRING_META_CHILD !== '1') {
    // 显式清理自己的沙箱（幂等，ENOENT 由 force 忽略）；exit 钩子是兜底。
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  // 隔离形态对齐 sibling：不把 apply 建的 runtime 单例、workspace 单例与
  // delivery id 留给下一个测试文件。
  setCurrentDeliveryId('');
  resetRuntimeForTest();
  resetWorkspaceForTest();
  if (originalDataDirEnv === undefined) delete process.env.HEARTBEAT_DATA_DIR;
  else process.env.HEARTBEAT_DATA_DIR = originalDataDirEnv;
  assert.equal(
    process.env.HEARTBEAT_DATA_DIR,
    originalDataDirEnv,
    'after() must restore HEARTBEAT_DATA_DIR to its original value',
  );
});

/** 宿主 effect 契约的最小复刻：fn 立即执行，返回的 disposer 收集起来，
 *  before() 结束前统一 dispose —— 定时器/监听全部清空，只留下纯闭包接线
 *  （rpc 路由、工具实例、runtime flags）供断言使用。 */
const disposers: Array<() => unknown> = [];
const runEffect = (fn: () => unknown): unknown => {
  const d = fn();
  if (typeof d === 'function') disposers.push(d as () => unknown);
  return d;
};

interface CapturedTool {
  name: string;
  execute?: (args: unknown, exec?: unknown) => Promise<unknown>;
}
let rpcRoute: { fetch(request: Request): Promise<Response> } | null = null;
const capturedTools: CapturedTool[] = [];

const connectionAgents = { get: () => undefined };
const scoped = {
  connection: {
    fetch: { register(route: { fetch(request: Request): Promise<Response> }): void { rpcRoute = route; } },
    admit: () => null,
  },
  tools: { register(def: CapturedTool): () => void { capturedTools.push(def); return () => {}; } },
  // installHeartbeatRpc 的回调把 scoped 当宿主上下文用（remoteCtx.connection /
  // remoteCtx.agents / remoteCtx.effect 都取自它），所以这三个也要在根上。
  agents: connectionAgents,
  effect: runEffect,
};

const fakeCtx = {
  get: () => undefined,
  inject(services: string[], cb: (scoped: unknown) => void): void {
    // 只挂载 connection / tools；settings、agentPresets、systemPrompt 等
    // 服务保持未挂载（cordis 语义：服务没来回调不跑），apply 里的其余注册
    // 全部走"宿主无此服务→审计降级"分支，不影响被测链路。
    if (services.every((s) => s in scoped)) cb(scoped);
  },
  on: () => () => {},
  effect: runEffect,
  logger: { info() {}, warn() {}, error() {}, debug() {} },
} as unknown as Parameters<typeof apply>[0];

before(async () => {
  pinSandbox();
  fs.mkdirSync(path.join(dataDir, 'settings'), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'settings', 'ui.json'),
    JSON.stringify({ concludeSilentTurn: true }),
    'utf8',
  );
  apply(fakeCtx, { dataDir, installPreset: false });
  for (const d of disposers.reverse()) {
    try { await d(); } catch { /* disposer best-effort,与宿主契约一致 */ }
  }
});

const runtimeConclude = (): boolean => getRuntime().flags.concludeSilentTurn?.() === true;

type RpcResult = { ok: boolean; value?: unknown; error?: { code?: string; message?: string } };
async function rpcCall(endpoint: string, patch: Record<string, unknown>): Promise<RpcResult> {
  assert.ok(rpcRoute, 'apply must register the heartbeat rpc route');
  const res = await rpcRoute.fetch(new Request('http://127.0.0.1' + RPC_ROUTE_PATH, {
    method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId: 'wiring-test', payload: { endpoint, ...patch } }),
  }));
  const body = await res.json() as { result?: RpcResult };
  return body.result ?? { ok: false, error: { message: 'no result envelope' } };
}

const seedReportTool = (): { execute: (args: unknown, exec?: unknown) => Promise<{ ok: boolean; message?: string }> } => {
  const tool = capturedTools.find((t) => t.name === 'seed_report');
  assert.ok(tool, 'apply must register the seed_report tool');
  assert.ok(typeof tool.execute === 'function', 'seed_report tool must expose execute');
  return tool as { execute: (args: unknown, exec?: unknown) => Promise<{ ok: boolean; message?: string }> };
};

const readAudit = (): Array<Record<string, unknown>> => {
  try {
    return fs.readFileSync(path.join(dataDir, 'logs', 'heartbeat.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch { return []; }
};

test('① ui.concludeSilentTurn=true 启动：runtime getter 读到 true', () => {
  assert.equal(runtimeConclude(), true);
});

test('② 走 config.set 回写：getter 跟随配置变化（apply 的 uiSet → ref）', async () => {
  const res = await rpcCall('config.set', { concludeSilentTurn: false });
  assert.equal(res.ok, true, `config.set failed: ${JSON.stringify(res.error)}`);
  assert.equal(runtimeConclude(), false, 'getter must follow the config.set write-back');
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings', 'ui.json'), 'utf8')) as { concludeSilentTurn?: boolean };
  assert.equal(saved.concludeSilentTurn, false, 'the patch must be persisted, not an in-memory illusion');
});

test('③ seed_report 工具拿到同一 ref：开关变化透传到 conclude 行为', async () => {
  pinSandbox();
  const tool = seedReportTool();

  // 开：允许 conclude
  assert.equal((await rpcCall('config.set', { concludeSilentTurn: true })).ok, true);
  assert.equal(runtimeConclude(), true);
  resetConcludeRequested();
  setCurrentDeliveryId('dt-wire-a');
  let concludedA = false;
  const outA = await tool.execute(
    { spoken: 'silent', delivery_id: 'dt-wire-a' },
    { concludeTurn: () => { concludedA = true; } },
  );
  assert.equal(outA.ok, true, outA.message);
  assert.equal(concludedA, true, 'gate ON: concludeTurn must be called through the wired ref');
  assert.ok((outA.message ?? '').includes('回合收尾:已结束'));
  assert.ok(
    readAudit().some((e) => e.event === 'conclude_silent_requested' && e.deliveryId === 'dt-wire-a'),
    'the wired audit sink must record conclude_silent_requested',
  );

  // 关：同一个工具实例，开关翻 OFF 后不再 conclude
  assert.equal((await rpcCall('config.set', { concludeSilentTurn: false })).ok, true);
  assert.equal(runtimeConclude(), false);
  resetConcludeRequested();
  setCurrentDeliveryId('dt-wire-b');
  let concludedB = false;
  const outB = await tool.execute(
    { spoken: 'silent', delivery_id: 'dt-wire-b' },
    { concludeTurn: () => { concludedB = true; } },
  );
  assert.equal(outB.ok, true, outB.message);
  assert.equal(concludedB, false, 'gate OFF: the same tool instance must NOT conclude');
  assert.ok(!(outB.message ?? '').includes('回合收尾'));
});

// meta：沙箱卫生的回归守卫。子进程跑本文件（只跑 ① 省时），退出后父进程
// 断言它建出来的沙箱目录已被删除。路径由子进程写进 HB_WIRING_META_REPORT
// 回报——不扫 %TEMP%（MSYS 下 "$TEMP"/hb-wiring-* 的反斜杠 glob 恒空，是
// 假 0），也不写死绝对路径（仓库根从 import.meta.url 推）。子进程里 after 的
// 字面 rmSync 被 HB_WIRING_META_CHILD 关掉，所以这里测的是 sandboxDir 的
// 退出钩子注册；把 sandboxDir('hb-wiring-') 换回裸 fs.mkdtempSync → 红。
test('meta: 子进程退出后不残留 hb-wiring-* 沙箱目录', { timeout: 30_000 }, async () => {
  if (process.env.HB_WIRING_META_CHILD === '1') return; // 子进程内不递归
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-meta-probe-'));
  const report = path.join(probeDir, 'sandbox-path.txt');
  let childSandbox = '';
  let out = '';
  let err = '';
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    // 本进程从 runner 继承了 NODE_TEST_CONTEXT/NODE_TEST_WORKER_ID；带进嵌套
    // 的 node --test 会让它以为自己是测试子进程、立即 0 退出且什么都不跑。
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HB_WIRING_META_CHILD: '1',
      HB_WIRING_META_REPORT: report,
    };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_WORKER_ID;
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--test', '--test-name-pattern', '①', path.join('tests', 'conclude-wiring.test.ts')],
        {
          cwd: root,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      child.stdout.on('data', (d) => { out += String(d); });
      child.stderr.on('data', (d) => { err += String(d); });
      child.on('close', (c) => resolve(c));
    });
    assert.equal(code, 0, `child test run failed (exit ${code})\n${out}\n${err}`);
    assert.ok(fs.existsSync(report), 'child must report the sandbox path it created');
    childSandbox = fs.readFileSync(report, 'utf8').trim();
    assert.ok(
      path.basename(childSandbox).startsWith('hb-wiring-'),
      `unexpected sandbox path: ${childSandbox}`,
    );
    assert.equal(
      fs.existsSync(childSandbox),
      false,
      `sandbox must not outlive the test process: ${childSandbox}`,
    );
  } finally {
    // 变异运行（sandboxDir 被换回裸 mkdtempSync）时清掉残留，免得 meta 用例
    // 自己变成泄漏源；上面的断言在清理之前已经执行。
    if (childSandbox && fs.existsSync(childSandbox)) {
      fs.rmSync(childSandbox, { recursive: true, force: true });
    }
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
});
