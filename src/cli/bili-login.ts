// `heartbeat bili login` — bilibili QR-code login (v2.2.0).
//
// Scans a QR code to log the user into bilibili and lands SESSDATA in the
// vault as <dataDir>/bilibili-session.json (shape: { sessdata, savedAt }).
// That file/field pair is a CROSS-SUBTASK contract with the data-source
// module (it reads `sessdata` back verbatim) — rename it and you break the
// reader, so treat it like a wire format.
//
// Flow (passport web QR login):
//   1. POST-less generate: GET .../web/qrcode/generate -> { url, qrcode_key }
//   2. Render the login url as a PNG (~400x400, margin 2) into the OS temp dir
//   3. Open it with the platform's default viewer (spawn the system command
//      directly, no shell wrapper). No GUI / missing viewer is NOT an error:
//      print the image path, its directory and the login url so the user can
//      open it by hand, then keep polling.
//   4. Poll .../web/qrcode/poll every 2s for up to 3 minutes:
//        0      success -> pull SESSDATA out of Set-Cookie (preferred) or the
//                        data.url query string, store it, delete the PNG
//        86101  not scanned yet -> keep going
//        86090  scanned, not confirmed -> keep going
//        86103  QR expired -> tell the user to rerun, exit non-zero
//   5. SESSDATA never reaches a log line, an error message, or stdout — the
//      only trace of it is the ciphertext in the vault container.
//
// Every side effect (fetch, render, open, sleep, clock, storage) is injected
// through BiliLoginDeps so the whole state machine runs in tests with a fake
// fetch and a fake renderer. Only `runBiliLogin`'s default wiring touches the
// real world; `main` (cli/index.ts) builds that wiring.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openerFor } from '../core/open-path.js';
import type { PathGuard } from '../core/path-guard.js';
import type { WorkspacePaths } from '../core/paths.js';
import { loadJson, saveJson } from '../vault/vault.js';

const GENERATE_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
const POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';

/**
 * Where the login cookie lands. CROSS-SUBTASK CONTRACT (reviewer, q-cbcb4c51c3b20b39):
 * the data-source module reads SESSDATA back from
 *   file: <dataDir>/bilibili-session.json  (KHBV2 container via vault.saveJson)
 *   shape: { "sessdata": "<SESSDATA value>", "savedAt": <ms timestamp> }
 * This file holds only the bilibili session — do not grow it into a flat key
 * table, and do not move or rename it without syncing the reader.
 */
export const BILI_SESSION_FILE_NAME = 'bilibili-session.json';

export function bilibiliSessionFilePath(paths: WorkspacePaths): string {
  return path.join(paths.dataDir, BILI_SESSION_FILE_NAME);
}

export interface BiliSessionRecord {
  sessdata: string;
  savedAt: number;
}

/**
 * Write the login cookie into the vault-managed session file (KHBV2 container
 * via vault.saveJson — the cookie value never touches the disk in plaintext).
 */
export function saveBiliSession(guard: PathGuard, paths: WorkspacePaths, value: string): void {
  const record: BiliSessionRecord = { sessdata: value, savedAt: Date.now() };
  saveJson(guard, bilibiliSessionFilePath(paths), record);
}

export interface BiliLoginDeps {
  fetchImpl: typeof fetch;
  /** Render `url` as a PNG at `file` (production: qrcode, 400x400, margin 2). */
  renderQrPng: (url: string, file: string) => Promise<void>;
  /** Open a file with the system viewer; false = could not (no GUI etc.). */
  openImage: (file: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  /** Line logger (stdout). Must never receive the cookie value. */
  log: (line: string) => void;
  /** Wall clock, ms. Injectable so the 3-minute deadline is testable. */
  now: () => number;
  /** Directory the QR PNG goes to (production: os.tmpdir()). */
  tmpDir?: string;
  platform: NodeJS.Platform;
  pollIntervalMs?: number;
  maxDurationMs?: number;
  /** Where the cookie is stored on success (production: vault). */
  saveCredential?: (value: string) => void;
}

interface GenerateOk {
  code: number;
  data: { url: string; qrcode_key: string };
}

interface PollResponse {
  code: number;
  message?: string;
  data?: { url?: string };
}

/**
 * Pull SESSDATA out of the poll response's Set-Cookie header(s). The cookie
 * is the primary source because it is what a browser session would carry.
 */
export function sessdataFromCookies(resp: Response): string | null {
  const cookies = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [];
  for (const cookie of cookies) {
    const first = cookie.split(';')[0]!.trim();
    if (first.startsWith('SESSDATA=')) {
      const value = first.slice('SESSDATA='.length);
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

/**
 * Fallback source: the SESSDATA query parameter on data.url (a redirect).
 * Extracted raw (URLSearchParams would percent-decode `%2C` into `,`), because
 * the value is stored and later sent as a Cookie — which carries the encoded
 * form — exactly like the Set-Cookie source above.
 */
export function sessdataFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const m = /[?&]SESSDATA=([^&]*)/.exec(new URL(url).search);
    return m && m[1]!.length > 0 ? m[1]! : null;
  } catch {
    return null;
  }
}

/**
 * Spawn the platform's default viewer directly (win32: `cmd /c start "" <path>`,
 * darwin: `open <path>`, linux: `xdg-open <path>` — the same command table as
 * core/open-path.ts) and report whether the spawn went out. Unlike openPath,
 * the caller needs to KNOW about failure: the no-GUI branch must print the
 * image path + directory + login url instead of silently doing nothing.
 * The `error` event is async (ENOENT does not throw synchronously), so wait
 * for either `spawn` (success) or `error`.
 */
export function tryOpenImage(platform: NodeJS.Platform, file: string): Promise<boolean> {
  const opener = openerFor(platform);
  return new Promise((resolve) => {
    try {
      const child = spawn(opener.cmd, opener.args(file), { detached: true, stdio: 'ignore' });
      child.once('error', () => resolve(false));
      child.once('spawn', () => resolve(true));
      // A viewer that exits nonzero (e.g. xdg-open with no DE) still opened
      // nothing, but the spawn itself went out — same contract as openPath.
    } catch {
      resolve(false);
    }
  });
}

/** Production QR renderer: `qrcode` is pure JS, PNG straight to file. */
async function renderQrPngProduction(url: string, file: string): Promise<void> {
  const { default: QRCode } = await import('qrcode');
  await QRCode.toFile(file, url, { type: 'png', width: 400, margin: 2 });
}

/** Status line for a poll code, without echoing anything sensitive. */
function pollStatusLine(code: number): string {
  if (code === 86101) return '等待扫码…';
  if (code === 86090) return '已扫码，请在手机上确认登录…';
  return `poll code ${code}`;
}

/**
 * The whole login flow. Returns the process exit code:
 *   0 = SESSDATA stored, 1 = expired / timed out / protocol error.
 */
export async function runBiliLogin(deps: BiliLoginDeps): Promise<number> {
  const pollIntervalMs = deps.pollIntervalMs ?? 2_000;
  const maxDurationMs = deps.maxDurationMs ?? 3 * 60_000;
  const platform = deps.platform;
  const tmpDir = deps.tmpDir ?? os.tmpdir();

  // 1. Generate.
  let gen: GenerateOk;
  try {
    const resp = await deps.fetchImpl(GENERATE_URL);
    gen = (await resp.json()) as GenerateOk;
  } catch (e) {
    deps.log(`获取二维码失败：${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (gen.code !== 0 || !gen.data?.url || !gen.data?.qrcode_key) {
    deps.log(`获取二维码失败：generate code=${gen.code}`);
    return 1;
  }
  const { url, qrcode_key } = gen.data;

  // 2. Render the PNG into the OS temp dir.
  const pngPath = path.join(tmpDir, `bili-login-qr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  try {
    await deps.renderQrPng(url, pngPath);
  } catch (e) {
    deps.log(`二维码渲染失败：${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  // 3. Try to open it; failure is a fallback, not an error.
  const opened = await deps.openImage(pngPath);
  if (!opened) {
    deps.log('无法自动打开图片（无 GUI 或缺少查看器）。请自己打开这张图用手机扫：');
    deps.log(`  图片：${pngPath}`);
    deps.log(`  目录：${path.dirname(pngPath)}`);
    deps.log(`  链接：${url}`);
  }

  // 4. Poll until success / expiry / deadline.
  const deadline = deps.now() + maxDurationMs;
  try {
    for (;;) {
      let poll: PollResponse | null = null;
      let resp: Response | null = null;
      try {
        resp = await deps.fetchImpl(`${POLL_URL}?qrcode_key=${encodeURIComponent(qrcode_key)}`);
        poll = (await resp.json()) as PollResponse;
      } catch (e) {
        deps.log(`轮询网络错误，重试中：${e instanceof Error ? e.message : String(e)}`);
      }
      if (poll) {
        if (poll.code === 0) {
          // SESSDATA: Set-Cookie first, then the data.url query param.
          const value = (resp ? sessdataFromCookies(resp) : null) ?? sessdataFromUrl(poll.data?.url);
          if (!value) {
            deps.log('登录成功但响应里找不到 SESSDATA（Set-Cookie 与 data.url 都没有），未写入。');
            return 1;
          }
          deps.saveCredential?.(value);
          deps.log('登录成功。SESSDATA 已加密存入 vault（bilibili-session.json 的 sessdata 字段），未在日志中显示原文。');
          return 0;
        }
        if (poll.code === 86103) {
          deps.log('二维码已过期，请重跑 `heartbeat bili login` 生成新的二维码。');
          return 1;
        }
        if (poll.code === 86101 || poll.code === 86090) {
          deps.log(pollStatusLine(poll.code));
        } else {
          // Unknown protocol code: report code only (message text is third-party).
          deps.log(`${pollStatusLine(poll.code)}，终止。`);
          return 1;
        }
      }
      if (deps.now() >= deadline) {
        deps.log('等待超时（3 分钟内未完成扫码确认），请重跑 `heartbeat bili login`。');
        return 1;
      }
      await deps.sleep(pollIntervalMs);
    }
  } finally {
    // 5. The temp PNG holds no secret, but it is a one-shot credential prompt —
    //    remove it whichever way the flow ends.
    try {
      fs.rmSync(pngPath, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Production wiring for `openImage` (platform command table). */
export function openImageProduction(platform: NodeJS.Platform): (file: string) => Promise<boolean> {
  return (file: string) => tryOpenImage(platform, file);
}

export { renderQrPngProduction, GENERATE_URL, POLL_URL };
