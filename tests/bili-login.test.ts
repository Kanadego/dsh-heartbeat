// bili login state machine, end to end with a fake fetch (v2.2.0).
// Covers: 未扫 → 已扫 → 成功 (Set-Cookie source), data.url fallback, 86103
// expiry, no-GUI fallback printing, the 3-minute deadline, the vault contract
// (`bilibili-session.json`, shape { sessdata, savedAt }) and the "SESSDATA
// never reaches a log line" rule.
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
      { body: { code: 86101 } },
      { body: { code: 86090 } },
      {
        body: { code: 0, data: { url: 'https://passport.bilibili.com/?SESSDATA=urlfallback%2Cvalue&bili_jct=x' } },
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
        body: { code: 0, data: { url: 'https://passport.bilibili.com/?SESSDATA=urlonly%2Cvalue&dedeuserid=1' } },
      },
    ]),
  });
  const code = await runBiliLogin(deps.deps);
  assert.equal(code, 0);
  assert.equal(deps.saved, 'urlonly%2Cvalue');
});

test('过期分支（86103）：退出码非 0，提示重跑', async () => {
  const deps = makeDeps({
    fetchImpl: fakeFetch([
      { body: { code: 86103 } },
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
      { body: { code: 0, data: { url: 'https://passport.bilibili.com/?SESSDATA=ok%2Cv' } } },
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
      { body: { code: 86101 } },
      { body: { code: 86101 } },
      { body: { code: 86101 } },
      { body: { code: 86101 } },
      { body: { code: 86101 } },
      { body: { code: 86101 } },
    ]),
    maxDurationMs: 6_000,
  });
  const code = await runBiliLogin(deps.deps);
  assert.equal(code, 1);
  assert.match(deps.logs.join('\n'), /超时/);
  assert.equal(deps.saved, null);
});

test('未知 poll code：终止并返回非 0', async () => {
  const deps = makeDeps({
    fetchImpl: fakeFetch([
      { body: { code: 99999 } },
    ]),
  });
  const code = await runBiliLogin(deps.deps);
  assert.equal(code, 1);
  assert.equal(deps.saved, null);
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
