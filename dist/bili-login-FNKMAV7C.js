import {
  openerFor
} from "./chunk-OCBE2AKW.js";
import {
  saveJson
} from "./chunk-M72T5MZU.js";
import "./chunk-IBBAISSW.js";

// src/cli/bili-login.ts
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
var GENERATE_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate";
var POLL_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll";
var BILI_SESSION_FILE_NAME = "bilibili-session.json";
function bilibiliSessionFilePath(paths) {
  return path.join(paths.dataDir, BILI_SESSION_FILE_NAME);
}
function saveBiliSession(guard, paths, value) {
  const record = { sessdata: value, savedAt: Date.now() };
  saveJson(guard, bilibiliSessionFilePath(paths), record);
}
function sessdataFromCookies(resp) {
  const cookies = typeof resp.headers.getSetCookie === "function" ? resp.headers.getSetCookie() : [];
  for (const cookie of cookies) {
    const first = cookie.split(";")[0].trim();
    if (first.startsWith("SESSDATA=")) {
      const value = first.slice("SESSDATA=".length);
      return value.length > 0 ? value : null;
    }
  }
  return null;
}
function sessdataFromUrl(url) {
  if (!url) return null;
  try {
    const m = /[?&]SESSDATA=([^&]*)/.exec(new URL(url).search);
    return m && m[1].length > 0 ? m[1] : null;
  } catch {
    return null;
  }
}
function tryOpenImage(platform, file) {
  const opener = openerFor(platform);
  return new Promise((resolve) => {
    try {
      const child = spawn(opener.cmd, opener.args(file), { detached: true, stdio: "ignore" });
      child.once("error", () => resolve(false));
      child.once("spawn", () => resolve(true));
    } catch {
      resolve(false);
    }
  });
}
async function renderQrPngProduction(url, file) {
  const { default: QRCode } = await import("qrcode");
  await QRCode.toFile(file, url, { type: "png", width: 400, margin: 2 });
}
function pollStatusLine(code) {
  if (code === 86101) return "\u7B49\u5F85\u626B\u7801\u2026";
  if (code === 86090) return "\u5DF2\u626B\u7801\uFF0C\u8BF7\u5728\u624B\u673A\u4E0A\u786E\u8BA4\u767B\u5F55\u2026";
  return `poll code ${code}`;
}
async function runBiliLogin(deps) {
  const pollIntervalMs = deps.pollIntervalMs ?? 2e3;
  const maxDurationMs = deps.maxDurationMs ?? 3 * 6e4;
  const platform = deps.platform;
  const tmpDir = deps.tmpDir ?? os.tmpdir();
  let gen;
  try {
    const resp = await deps.fetchImpl(GENERATE_URL);
    gen = await resp.json();
  } catch (e) {
    deps.log(`\u83B7\u53D6\u4E8C\u7EF4\u7801\u5931\u8D25\uFF1A${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (gen.code !== 0 || !gen.data?.url || !gen.data?.qrcode_key) {
    deps.log(`\u83B7\u53D6\u4E8C\u7EF4\u7801\u5931\u8D25\uFF1Agenerate code=${gen.code}`);
    return 1;
  }
  const { url, qrcode_key } = gen.data;
  const pngPath = path.join(tmpDir, `bili-login-qr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  try {
    await deps.renderQrPng(url, pngPath);
  } catch (e) {
    deps.log(`\u4E8C\u7EF4\u7801\u6E32\u67D3\u5931\u8D25\uFF1A${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const opened = await deps.openImage(pngPath);
  if (!opened) {
    deps.log("\u65E0\u6CD5\u81EA\u52A8\u6253\u5F00\u56FE\u7247\uFF08\u65E0 GUI \u6216\u7F3A\u5C11\u67E5\u770B\u5668\uFF09\u3002\u8BF7\u81EA\u5DF1\u6253\u5F00\u8FD9\u5F20\u56FE\u7528\u624B\u673A\u626B\uFF1A");
    deps.log(`  \u56FE\u7247\uFF1A${pngPath}`);
    deps.log(`  \u76EE\u5F55\uFF1A${path.dirname(pngPath)}`);
    deps.log(`  \u94FE\u63A5\uFF1A${url}`);
  }
  const deadline = deps.now() + maxDurationMs;
  try {
    for (; ; ) {
      let poll = null;
      let resp = null;
      try {
        resp = await deps.fetchImpl(`${POLL_URL}?qrcode_key=${encodeURIComponent(qrcode_key)}`);
        poll = await resp.json();
      } catch (e) {
        deps.log(`\u8F6E\u8BE2\u7F51\u7EDC\u9519\u8BEF\uFF0C\u91CD\u8BD5\u4E2D\uFF1A${e instanceof Error ? e.message : String(e)}`);
      }
      if (poll) {
        if (poll.code === 0) {
          const value = (resp ? sessdataFromCookies(resp) : null) ?? sessdataFromUrl(poll.data?.url);
          if (!value) {
            deps.log("\u767B\u5F55\u6210\u529F\u4F46\u54CD\u5E94\u91CC\u627E\u4E0D\u5230 SESSDATA\uFF08Set-Cookie \u4E0E data.url \u90FD\u6CA1\u6709\uFF09\uFF0C\u672A\u5199\u5165\u3002");
            return 1;
          }
          deps.saveCredential?.(value);
          deps.log("\u767B\u5F55\u6210\u529F\u3002SESSDATA \u5DF2\u52A0\u5BC6\u5B58\u5165 vault\uFF08bilibili-session.json \u7684 sessdata \u5B57\u6BB5\uFF09\uFF0C\u672A\u5728\u65E5\u5FD7\u4E2D\u663E\u793A\u539F\u6587\u3002");
          return 0;
        }
        if (poll.code === 86103) {
          deps.log("\u4E8C\u7EF4\u7801\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u8DD1 `heartbeat bili login` \u751F\u6210\u65B0\u7684\u4E8C\u7EF4\u7801\u3002");
          return 1;
        }
        if (poll.code === 86101 || poll.code === 86090) {
          deps.log(pollStatusLine(poll.code));
        } else {
          deps.log(`${pollStatusLine(poll.code)}\uFF0C\u7EC8\u6B62\u3002`);
          return 1;
        }
      }
      if (deps.now() >= deadline) {
        deps.log("\u7B49\u5F85\u8D85\u65F6\uFF083 \u5206\u949F\u5185\u672A\u5B8C\u6210\u626B\u7801\u786E\u8BA4\uFF09\uFF0C\u8BF7\u91CD\u8DD1 `heartbeat bili login`\u3002");
        return 1;
      }
      await deps.sleep(pollIntervalMs);
    }
  } finally {
    try {
      fs.rmSync(pngPath, { force: true });
    } catch {
    }
  }
}
function openImageProduction(platform) {
  return (file) => tryOpenImage(platform, file);
}
export {
  BILI_SESSION_FILE_NAME,
  GENERATE_URL,
  POLL_URL,
  bilibiliSessionFilePath,
  openImageProduction,
  renderQrPngProduction,
  runBiliLogin,
  saveBiliSession,
  sessdataFromCookies,
  sessdataFromUrl,
  tryOpenImage
};
//# sourceMappingURL=bili-login-FNKMAV7C.js.map