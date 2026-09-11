// 会话日志 v0 成员修复工具（scripts/repair-v0-members.mjs）
//
// 病因（2026-09-12，DSH 0.1.2-rc.1 → 0.1.5-rc.2 升级现场）：
//   0.1.5 的会话格式 v0→v1 翻译器（@deepseek-ai/dsh-session-format-v0-to-v1）
//   采用严格白名单校验，而 0.1.2 时代的 dsh-compaction-basic 在
//   `compaction/summary` 事件 data 里写过白名单外的成员
//   （tier / topic / directMessageIds / effectiveMessageIds / kernelBlockId），
//   导致迁移整会话被拒：
//   `failed to observe session "<id>": …v0-to-v1 refuses this format v0
//    Session: compaction/summary <seq> data has unexpected member "tier"`
//   另有 r5 之前的旧版心跳投递残留：`agent/inbox/spliced` 的 inserted 消息
//   缺 `id`（与 repair-session.mjs 修过的同一个病，同款方子：补 UUID）。
//
// 修法（手术式，复刻自 .probe-015 现场修复，65/65 全部通过宿主真翻译器复核）：
//   1. 用宿主同款翻译器逐事件预检（依赖直接解析自全局 dsh 安装，零额外安装）；
//   2. 只对报 "unexpected member" 的事件剥离白名单外成员；
//      对 "inserted message lacks required member id" 补 crypto.randomUUID()；
//   3. 帧保持式回写：只重压受影响的帧，首帧=单条 header 的不变量不动；
//   4. 改前逐文件备份（.bak-pre-v0fix-<ts>），修完自动复核归零。
//
// 用法：
//   node scripts/repair-v0-members.mjs            # 预检（默认，只读不动文件）
//   node scripts/repair-v0-members.mjs fix        # 备份 + 修复 + 复核
//   node scripts/repair-v0-members.mjs --root <dir>  # 扫描别的会话根（默认 ~/.dsh/sessions）
//
// 注意：
//   - 只处理 v0 产物（header.version === 0 的 session.jsonl.zstd）；已经迁移成
//     v1+ 代文件的会话（session.v*.jsonl.zstd）不会碰。
//   - 运行前请先备份整个 sessions 目录（DSH 0.1.5 升级会触发 v3 迁移，动用户数据）。
//   - 遇到本工具报 UNFIXABLE 的事件，说明是未知的新违规形态——把输出发给维护者，
//     不要手改文件。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// ── 依赖解析：翻译器 bundled 在全局 dsh 安装的 node_modules 里 ─────────
const requireFromHere = createRequire(import.meta.url);
function resolveTranslator() {
  const candidates = [];
  // 1) 与本插件同级能解析到就直接用（pnpm 布局里可能提升过）
  try {
    candidates.push(path.dirname(requireFromHere.resolve('@deepseek-ai/dsh-session-format-v0-to-v1/package.json')));
  } catch { /* not hoisted */ }
  // 2) 全局 dsh 安装（`npm i -g @deepseek-ai/dsh` 的标准位置）
  const globalRoots = [
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh') : undefined,
  ].filter(Boolean);
  for (const root of globalRoots) {
    if (fs.existsSync(path.join(root, 'node_modules', '@deepseek-ai', 'dsh-session-format-v0-to-v1'))) {
      candidates.push(root);
      break;
    }
  }
  for (const root of candidates) {
    try {
      const requireFromDsh = createRequire(path.join(root, 'package.json'));
      return {
        translator: requireFromDsh('@deepseek-ai/dsh-session-format-v0-to-v1'),
        sessionFormat: requireFromDsh('@deepseek-ai/dsh-session-format'),
      };
    } catch { /* try next candidate */ }
  }
  console.error('找不到 @deepseek-ai/dsh-session-format-v0-to-v1（需要已安装 DSH ≥ 0.1.5）。');
  console.error('如果 DSH 装在非标准位置，请设置 APPDATA 环境变量或把本工具放到能解析到宿主包的位置。');
  process.exit(2);
}
const { translator, sessionFormat } = resolveTranslator();
const { assertReleasedEventPayload, isReleasedAssistantChunkRun } = translator;
const { SessionFormatError } = sessionFormat;

// ── 参数 ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const MODE = argv.find((a) => a === 'check' || a === 'fix') ?? 'check';
const rootIdx = argv.indexOf('--root');
const SESSIONS_ROOT = rootIdx >= 0 ? path.resolve(argv[rootIdx + 1] ?? '.') : path.join(os.homedir(), '.dsh', 'sessions');

// ── 多帧 zstd 切分/解码（与 repair-session.mjs v3 同逻辑）─────────────
function* splitFrames(buf) {
  let i = 0;
  while (i < buf.length) {
    if (!(buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd)) { yield buf.subarray(i); return; }
    let j = i + 4;
    while (j < buf.length && !(buf[j] === 0x28 && buf[j + 1] === 0xb5 && buf[j + 2] === 0x2f && buf[j + 3] === 0xfd)) j++;
    yield buf.subarray(i, j); i = j;
  }
}
function decodeFile(file) {
  const buf = fs.readFileSync(file);
  const frames = [];
  for (const f of splitFrames(buf)) {
    if (f.length === 0) continue;
    const text = zlib.zstdDecompressSync(f).toString('utf8');
    frames.push({ bytes: f, lines: text.split('\n') });
  }
  return frames;
}

// ── 逐事件预检：复刻宿主 transformEvent 的校验面 ──────────────────────
function validateEvent(record) {
  // packed assistant-chunk run 在宿主管线里整段跳过 payload 断言
  if (isReleasedAssistantChunkRun(record)) return null;
  try {
    assertReleasedEventPayload(record, 0);
    return null;
  } catch (e) {
    if (e instanceof SessionFormatError) return e.message;
    throw e;
  }
}

function stripUnexpected(record, message) {
  const m = message.match(/data has unexpected member "([^"]+)"/);
  if (!m) return null;
  const member = m[1];
  if (!record.data || !Object.hasOwn(record.data, member)) return null;
  const data = { ...record.data };
  delete data[member];
  return { ...record, data };
}

// r5 旧投递 bug 残留：inserted 消息缺 id —— 补一个 UUID（与正常消息 id 同形）
function fixMissingMessageId(record, message) {
  if (!/inserted message lacks required member "id"$/.test(message)) return null;
  if (record.type !== 'agent/inbox/spliced' || !Array.isArray(record.data?.inserted)) return null;
  const inserted = record.data.inserted.map((msg) => (
    msg && typeof msg === 'object' && !Object.hasOwn(msg, 'id') ? { ...msg, id: randomUUID() } : msg
  ));
  return { ...record, data: { ...record.data, inserted } };
}

// ── 主流程 ────────────────────────────────────────────────────────────
function* v0SessionFiles(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) yield* v0SessionFiles(p);
      else if (e.name === 'session.jsonl.zstd') yield p;
    }
  }
}

let totalFixed = 0;
const failed = [];
for (const file of v0SessionFiles(SESSIONS_ROOT)) {
  let frames;
  try { frames = decodeFile(file); } catch (e) { console.log('SKIP(decode-fail)', file, String(e).slice(0, 80)); continue; }
  if (frames.length === 0) continue;

  // 只处理 v0 产物（首行 header.version === 0；v1+ 代文件不会叫这个名字，双保险）
  try {
    const first = frames[0].lines.map((l) => l.trim()).filter(Boolean);
    const header = JSON.parse(first[0]);
    if (header?.version !== 0) continue;
  } catch { continue; }

  const changes = [];
  for (let fi = 0; fi < frames.length; fi++) {
    for (let li = 0; li < frames[fi].lines.length; li++) {
      const raw = frames[fi].lines[li];
      if (!raw.trim()) continue;
      let rec; try { rec = JSON.parse(raw); } catch { continue; }
      if (typeof rec?.type !== 'string' || typeof rec?.seq !== 'number') continue;
      const err = validateEvent(rec);
      if (err === null) continue;
      const fixed = fixMissingMessageId(rec, err) ?? stripUnexpected(rec, err);
      if (fixed === null) { failed.push({ file, seq: rec.seq, type: rec.type, err }); continue; }
      // 剥离后必须真的过检；还有别的违规成员就继续剥（有界，防意外循环）
      let check = fixed, guard = 0;
      let lastErr = validateEvent(check);
      while (lastErr !== null && guard++ < 8) {
        const again = stripUnexpected(check, lastErr);
        if (again === null) break;
        check = again;
        lastErr = validateEvent(check);
      }
      if (lastErr !== null) { failed.push({ file, seq: rec.seq, type: rec.type, err: lastErr }); continue; }
      changes.push({ frameIdx: fi, lineIdx: li, record: check });
    }
  }

  if (changes.length === 0 && failed.length === 0) continue;
  const sessionId = path.basename(path.dirname(file));
  const unfixableHere = failed.filter((f) => f.file === file).length;
  console.log(`${sessionId} | fixable: ${changes.length} | unfixable: ${unfixableHere}`);

  if (MODE !== 'fix' || changes.length === 0) { totalFixed += changes.length; continue; }

  // ── 修复：备份 → 帧保持式回写（只重压受影响的帧）──────────────────
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = file + '.bak-pre-v0fix-' + stamp;
  fs.copyFileSync(file, backup);
  const byFrame = new Map();
  for (const c of changes) {
    if (!byFrame.has(c.frameIdx)) byFrame.set(c.frameIdx, new Map());
    byFrame.get(c.frameIdx).set(c.lineIdx, JSON.stringify(c.record));
  }
  const out = [];
  for (let fi = 0; fi < frames.length; fi++) {
    const repl = byFrame.get(fi);
    if (!repl) { out.push(frames[fi].bytes); continue; }
    const newLines = frames[fi].lines.map((l, li) => (repl.has(li) ? repl.get(li) : l));
    out.push(zlib.zstdCompressSync(Buffer.from(newLines.join('\n'), 'utf8')));
  }
  fs.writeFileSync(file, Buffer.concat(out));
  console.log(`  FIXED: ${changes.length} events | backup: ${path.basename(backup)}`);
  totalFixed += changes.length;
}

console.log(`\n[${MODE}] fixable events total = ${totalFixed}, unfixable = ${failed.length}`);
for (const f of failed) {
  console.log('  UNFIXABLE', path.basename(path.dirname(f.file)), 'seq', f.seq, f.type, '|', f.err.slice(0, 140));
}
if (MODE === 'check' && totalFixed > 0) console.log('确认无误后用 `node scripts/repair-v0-members.mjs fix` 执行修复。');
if (MODE === 'fix' && failed.length > 0) process.exit(1);
