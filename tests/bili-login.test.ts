// bili login state machine, end to end with a fake fetch (v2.2.0).
// Covers: 未扫 → 已扫 → 成功 (Set-Cookie source), data.url fallback,
// data.code=86038 expiry, the legacy flat-code shape compat, no-GUI fallback
// printing, the 3-minute deadline, the vault contract
// (`bilibili-session.json`, shape { sessdata, savedAt }) and the "SESSDATA
// never reaches a log line" rule.
//
// Poll steps use the REAL response shape measured on 2026-11-09: the outer
// `code` is the API call status (stays 0) and the login state lives in
// `data.code` (86101 未扫 / 86090 已扫 / 86038 过期 / 0 成功).
import { sandboxDir } from './_sandbox.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import {
  containerKind,
  loadJson,
  resetVaultKeyCacheForTest,
  setVaultPlatformForTest,
} from '../src/vault/vault.js';
import {
  BILI_SESSION_FILE_NAME,
  bilibiliSessionFilePath,
  createBiliLoginService,
  runBiliLogin,
  saveBiliSession,
  sessdataFromCookies,
  sessdataFromUrl,
} from '../src/cli/bili-login.js';

let sandbox = '';

beforeEach(() => {
  sandbox = sandboxDir('hb-bili-');
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  resetVaultKeyCacheForTest();
  setVaultPlatformForTest(null);
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
  resetVaultKeyCacheForTest();
  setVaultPlatformForTest(null);
});

const GENERATE_BODY = { code: 0, data: { url: 'https://passport.bilibili.com/h5-app/passport/login?qr=FAKE', qrcode_key: 'key-1' } };

/** One queued HTTP answer; steps are consumed in call order. */
interface Step {
  body: unknown;
  headers?: Record<string, string>;
}

/** Build a fake fetch: generate first, then the queued poll answers. */
function fakeFetch(steps: Step[], urls: string[] = []): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    urls.push(String(input));
    if (urls.length === 1) {
      assert.equal(String(input), 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate');
      return new Response(JSON.stringify(GENERATE_BODY));
    }
    const step = steps.shift();
    assert.ok(step, `unexpected fetch call #${urls.length}: ${String(input)}`);
    const headerInit: [string, string][] = step.headers
      ? Object.entries(step.headers).map(([k, v]) => [k, v] as [string, string])
      : [];
    return new Response(JSON.stringify(step.body), { headers: headerInit });
  }) as typeof fetch;
}

/** Shared harness: controllable clock (2s per call, i.e. one poll interval),
 *  no-op sleep, a renderer that really writes the temp PNG (so cleanup is
 *  observable), and captures for the open/save/log side effects. */
function makeDeps(opts: {
  fetchImpl: typeof fetch;
  openResult?: boolean;
  maxDurationMs?: number;
}) {
  const logs: string[] = [];
  let t = 0;
  let rendered: string | null = null;
  let opened: string | null = null;
  let saved: string | null = null;
  const tmpDir = path.join(sandbox, 'qr-tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const deps = {
    fetchImpl: opts.fetchImpl,
    renderQrPng: async (url: string, file: string) => {
      assert.equal(url, GENERATE_BODY.data.url);
      fs.writeFileSync(file, 'fake-png');
      rendered = file;
    },
    openImage: async (file: string) => {
      opened = file;
      return opts.openResult ?? true;
    },
    sleep: async () => {},
    log: (line: string) => logs.push(line),
    now: () => (t += 2_000),
    tmpDir,
    platform: 'win32' as NodeJS.Platform,
    ...(opts.maxDurationMs !== undefined ? { maxDurationMs: opts.maxDurationMs } : {}),
    saveCredential: (value: string) => {
      saved = value;
    },
  };
  return {
    deps,
    logs,
    get rendered() { return rendered; },
    get opened() { return opened; },
    get saved() { return saved; },
  };
}

test('状态机：未扫 → 已扫 → 成功，SESSDATA 取自 Set-Cookie', async () => {
  const urls: string[] = [];
  const deps = makeDeps({
    fetchImpl: fakeFetch([
      { body: { code: 0, data: { code: 86101, message: '未扫码' } } },
      { body: { code: 0, data: { code: 86090, message: '已扫码待确认' } } },
      {
        body: { code: 0, data: { code: 0, url: 'https://passport.bilibili.com/?SESSDATA=urlfallback%2Cvalue&bili_jct=x' } },
        headers: { 'Set-Cookie': 'SESSDATA=cookie%2Cvalue; Path=/; HttpOnly' },
      },
    ], urls),
  });
  const code = await runBiliLogin(deps.deps);
  assert.equal(code, 0);
  assert.match(urls[1]!, /qrcode\/poll\?qrcode_key=key-1$/);
  assert.match(deps.logs.join('\n'), /等待扫码/);
  assert.match(deps.logs.join('\n'), /已扫码/);
  // Cookie is the primary source; the url fallback must not win.
  assert.equal(deps.saved, 'cookie%2Cvalue');
  // SESSDATA never reaches a log line, in either encoding.
  const allLogs = deps.logs.join('\n');
  assert.equal(allLogs.includes('cookie%2Cvalue'), false, 'cookie value leaked into logs');
  assert.equal(allLogs.includes('urlfallback'), false, 'url fallback leaked into logs');
  assert.match(allLogs, /bilibili-session\.json/);
  // Temp PNG is cleaned up.
  assert.notEqual(deps.rendered, null);
  assert.equal(fs.existsSync(deps.rendered!), false);
});

test('成功时写入 vault 的 key 正确（bilibili-session.json 的 sessdata 字段，KHBV2 容器）', async () => {
  const guard = createPathGuard(workspace().dataDir);
  const paths = workspace();
  saveBiliSession(guard, paths, 'sessdata-value');
  const file = bilibiliSessionFilePath(paths);
  assert.equal(path.basename(file), BILI_SESSION_FILE_NAME);
  assert.equal(containerKind(file), 'v2');
  const record = loadJson<{ sessdata: string; savedAt: number }>(guard, file);
  assert.equal(record!.sessdata, 'sessdata-value');
  assert.ok(Number.isFinite(record!.savedAt));
  // The file holds exactly one thing — the bilibili session (reviewer contract).
  assert.deepEqual(Object.keys(record!).sort(), ['savedAt', 'sessdata']);
});

test('Set-Cookie 没有 SESSDATA 时回退到 data.url 查询参数', async () => {
  const deps = makeDeps({
    fetchImpl: fakeFetch([
      {
        body: { code: 0, data: { code: 0, url: 'https://passport.bilibili.com/?SESSDATA=urlonly%2Cvalue&dedeuserid=1' } },
      },
    ]),
  });
  const code = await runBiliLogin(deps.deps);
  assert.equal(code, 0);
  assert.equal(deps.saved, 'urlonly%2Cvalue');
});

test('过期分支（data.code=86038）：退出码非 0，提示重跑', async () => {
  const deps = makeDeps({
    fetchImpl: fakeFetch([
      { body: { code: 0, data: { code: 86038, message: '二维码已失效' } } },
    ]),
  });
  const code = await runBiliLogin(deps.deps);
  assert.equal(code, 1);
  const allLogs = deps.logs.join('\n');
  assert.match(allLogs, /过期/);
  assert.match(allLogs, /bili login/);
  assert.equal(deps.saved, null);
  assert.equal(fs.existsSync(deps.rendered!), false);
});

test('无 GUI 分支：不抛错，打印图片路径、目录与登录链接', async () => {
  const deps = makeDeps({
    fetchImpl: fakeFetch([
      { body: { code: 0, data: { code: 0, url: 'https://passport.bilibili.com/?SESSDATA=ok%2Cv' } } },
    ]),
    openResult: false,
  });
  const code = await runBiliLogin(deps.deps);
  assert.equal(code, 0);
  const allLogs = deps.logs.join('\n');
  assert.match(allLogs, /自己打开这张图用手机扫/);
  assert.match(allLogs, new RegExp(deps.rendered!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(allLogs, new RegExp(path.dirname(deps.rendered!).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(allLogs, /https:\/\/passport\.bilibili\.com\/h5-app\/passport\/login\?qr=FAKE/);
  assert.equal(deps.opened, deps.rendered);
});

test('超时分支：3 分钟内未完成 → 退出码非 0', async () => {
  const deps = makeDeps({
    fetchImpl: fakeFetch([
      { body: { code: 0, data: { code: 86101 } } },
      { body: { code: 0, data: { code: 86101 } } },
      { body: { code: 0, data: { code: 86101 } } },
      { body: { code: 0, data: { code: 86101 } } },
      { body: { code: 0, data: { code: 86101 } } },
      { body: { code: 0, data: { code: 86101 } } },
    ]),
    maxDurationMs: 6_000,
  });
  const code = await runBiliLogin(deps.deps);
  assert.equal(code, 1);
  assert.match(deps.logs.join('\n'), /超时/);
  assert.equal(deps.saved, null);
});

test('未知 poll code（data.code）：终止并返回非 0，不打印第三方 message', async () => {
  const deps = makeDeps({
    fetchImpl: fakeFetch([
      { body: { code: 0, message: 'OK', data: { code: 99999, message: '第三方原文' } } },
    ]),
  });
  const code = await runBiliLogin(deps.deps);
  assert.equal(code, 1);
  assert.equal(deps.saved, null);
  const allLogs = deps.logs.join('\n');
  assert.match(allLogs, /poll code 99999/);
  assert.equal(allLogs.includes('第三方原文'), false, 'third-party message leaked into logs');
});

test('老形态兼容：只有外层 code（无 data.code）时仍按外层码分支', async () => {
  const deps = makeDeps({
    fetchImpl: fakeFetch([
      { body: { code: 86101 } },
      { body: { code: 86090 } },
      { body: { code: 0, data: { url: 'https://passport.bilibili.com/?SESSDATA=legacy%2Cv' } } },
    ]),
  });
  const code = await runBiliLogin(deps.deps);
  assert.equal(code, 0);
  assert.equal(deps.saved, 'legacy%2Cv');
});

test('回归：未扫码（外层 code=0 + data.code=86101）不得误判为登录成功', async () => {
  const deps = makeDeps({
    fetchImpl: fakeFetch([
      { body: { code: 0, message: 'OK', ttl: 1, data: { url: '', refresh_token: '', timestamp: 0, code: 86101, message: '未扫码' } } },
      { body: { code: 0, message: 'OK', ttl: 1, data: { url: '', refresh_token: '', timestamp: 0, code: 86101, message: '未扫码' } } },
    ]),
    maxDurationMs: 4_000,
  });
  const code = await runBiliLogin(deps.deps);
  assert.equal(code, 1, 'must not exit 0 without scanning');
  assert.equal(deps.saved, null);
  const allLogs = deps.logs.join('\n');
  assert.match(allLogs, /等待扫码/);
  assert.equal(allLogs.includes('找不到 SESSDATA'), false, 'false success branch hit');
});

test('sessdataFromCookies：多个 cookie 时精确匹配 SESSDATA，空值不采纳', () => {
  const resp = new Response(null, {
    headers: [
      ['Set-Cookie', 'LIVE_BUVID=abc; Path=/'],
      ['Set-Cookie', 'SESSDATA=good%2Cvalue; Path=/; HttpOnly'],
      ['Set-Cookie', 'SESSDATA=; Path=/'],
    ],
  });
  assert.equal(sessdataFromCookies(resp), 'good%2Cvalue');
  const empty = new Response(null, { headers: { 'Set-Cookie': 'SESSDATA=; Path=/' } });
  assert.equal(sessdataFromCookies(empty), null);
  const none = new Response(null);
  assert.equal(sessdataFromCookies(none), null);
});

test('sessdataFromUrl：非 URL 输入返回 null 而不是抛错', () => {
  assert.equal(sessdataFromUrl('not a url'), null);
  assert.equal(sessdataFromUrl(undefined), null);
  assert.equal(sessdataFromUrl(null), null);
  assert.equal(sessdataFromUrl('https://x.test/?SESSDATA=a%2Cb'), 'a%2Cb');
});

// ── 面板用两步式登录服务（createBiliLoginService，v2.3.0）────────────────
// 同一套假 fetch；二维码渲染注入成假 dataURL，保存注入成真 vault 写入
// （saveBiliSession），让「成功写 vault」可以被读回来断言。
const QR_DATA_URL = 'data:image/png;base64,FAKEQR';

function makeService(opts: {
  steps: Step[];
  /** 每次时钟调用的步进（ms）。默认 1s：几次调用远碰不到 3 分钟 TTL。 */
  tickMs?: number;
  /** 真写 vault（saveBiliSession）时为 true；否则只记录收到的值。 */
  realVault?: boolean;
}) {
  const guard = createPathGuard(workspace().dataDir);
  const paths = workspace();
  const urls: string[] = [];
  const saved: string[] = [];
  let t = 0;
  const service = createBiliLoginService({
    fetchImpl: fakeFetch(opts.steps, urls),
    renderQrDataUrl: async (url) => {
      assert.equal(url, GENERATE_BODY.data.url);
      return QR_DATA_URL;
    },
    now: () => (t += opts.tickMs ?? 1_000),
    saveCredential: (value) => {
      saved.push(value);
      if (opts.realVault) saveBiliSession(guard, paths, value);
    },
  });
  return { service, urls, saved, guard, paths };
}

test('面板服务：startBiliLogin 返回 png dataURL 二维码 + 会话，不落临时文件', async () => {
  const { service } = makeService({ steps: [] });
  const res = await service.startBiliLogin();
  assert.match(res.qrDataUrl, /^data:image\/png;base64,/);
  assert.ok(res.sessionId.length > 0);
  // 会话 3 分钟 TTL：expiresAt = now + 180_000（start 消耗两次时钟：sweep 一次、打时间戳一次）
  assert.equal(res.expiresAt - 180_000, 2_000);
  // 不产生任何文件系统副作用（二维码只活在 dataURL 里）
  const entries = fs.readdirSync(sandbox);
  assert.deepEqual(entries.filter((e) => e.includes('bili-login-qr')), []);
});

test('面板服务 poll 四态：waiting → scanned → success（SESSDATA 走 Set-Cookie）', async () => {
  const { service, saved } = makeService({
    steps: [
      { body: { code: 0, data: { code: 86101, message: '未扫码' } } },
      { body: { code: 0, data: { code: 86090, message: '已扫码待确认' } } },
      {
        body: { code: 0, data: { code: 0, url: 'https://passport.bilibili.com/?SESSDATA=urlfallback%2Cv' } },
        headers: { 'Set-Cookie': 'SESSDATA=rpc%2Cv; Path=/; HttpOnly' },
      },
    ],
  });
  const start = await service.startBiliLogin();
  assert.equal((await service.pollBiliLogin(start.sessionId)).state, 'waiting');
  assert.equal((await service.pollBiliLogin(start.sessionId)).state, 'scanned');
  const done = await service.pollBiliLogin(start.sessionId);
  assert.equal(done.state, 'success');
  assert.equal(done.message, undefined);
  // Cookie 是首选来源，url 兜底不得反超
  assert.deepEqual(saved, ['rpc%2Cv']);
});

test('面板服务：success 写 vault 且会话被清理；再 poll 返回 expired（不再写第二次）', async () => {
  const { service, saved, guard, paths } = makeService({
    steps: [
      { body: { code: 0, data: { code: 0, url: 'https://passport.bilibili.com/?SESSDATA=vaulted%2Cv' } } },
    ],
    realVault: true,
  });
  const start = await service.startBiliLogin();
  assert.equal((await service.pollBiliLogin(start.sessionId)).state, 'success');
  // vault 里按契约落了 { sessdata, savedAt }（KHBV2 容器）
  const record = loadJson<{ sessdata: string; savedAt: number }>(guard, bilibiliSessionFilePath(paths));
  assert.equal(record!.sessdata, 'vaulted%2Cv');
  assert.ok(Number.isFinite(record!.savedAt));
  // 会话一次性：同一 sessionId 再 poll 直接 expired，且不再打网络（steps 已空）
  const again = await service.pollBiliLogin(start.sessionId);
  assert.equal(again.state, 'expired');
  assert.deepEqual(saved, ['vaulted%2Cv']);
});

test('面板服务：过期会话 poll 返回 expired（TTL 到点本地清理 + 86038 服务端过期）', async () => {
  // (a) 本地 TTL：时钟每次 +200s，第二次调用（首次 poll）已越过 3 分钟
  const a = makeService({ steps: [], tickMs: 200_000 });
  const start = await a.service.startBiliLogin();
  const r = await a.service.pollBiliLogin(start.sessionId);
  assert.equal(r.state, 'expired');
  assert.deepEqual(a.urls.length, 1, 'TTL 过期不得打 poll 网络');
  // (b) 服务端过期：data.code=86038 → expired，会话被清
  const b = makeService({ steps: [{ body: { code: 0, data: { code: 86038, message: '二维码已失效' } } }] });
  const start2 = await b.service.startBiliLogin();
  assert.equal((await b.service.pollBiliLogin(start2.sessionId)).state, 'expired');
  assert.equal((await b.service.pollBiliLogin(start2.sessionId)).state, 'expired');
  assert.equal(b.urls.length, 2, '86038 后会话已清，第二次 poll 不打网络');
  assert.deepEqual(b.saved, []);
});
