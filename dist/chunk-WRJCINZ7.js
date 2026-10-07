import {
  activeSeeds,
  loadPool,
  normalizeCategory,
  seedsFilePath
} from "./chunk-KOOQOMQY.js";
import {
  appendAuditLine
} from "./chunk-OYVNWB5G.js";
import {
  loadEncryptedText,
  loadJson,
  readText,
  saveEncryptedText,
  saveJson,
  workspace,
  writeText
} from "./chunk-7TW6DD6Q.js";
import {
  atomicWriteJsonSync
} from "./chunk-WRUTATW4.js";

// src/ledger/ledger.ts
import path from "path";
import { randomUUID } from "crypto";
var DAY_MS = 864e5;
function ledgerFilePath(dataDir) {
  return path.join(dataDir, "ledger.md");
}
var LINE_RE = /^- \[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\]\[(open|done)\]\[#([0-9a-f]{6})\] (.*)$/;
function renderEntry(e) {
  return `- [${e.date} ${e.time}][${e.status}][#${e.id}] ${e.text}`;
}
function readLedger(guard, file) {
  const raw = readText(guard, file, "# \u8D26\u672C\n");
  const lines = raw.split("\n");
  const entries = [];
  const rawLines = [];
  for (const line of lines) {
    const m = LINE_RE.exec(line);
    if (m) {
      entries.push({ date: m[1], time: m[2], status: m[3], id: m[4], text: m[5] });
    }
    rawLines.push(line);
  }
  return { header: lines[0] ?? "# \u8D26\u672C", entries, rawLines };
}
function appendEntry(guard, file, text, now = Date.now()) {
  const textTrimmed = text.trim();
  if (!textTrimmed) throw new Error("ledger entry must not be empty");
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, "0");
  const entry = {
    id: randomUUID().slice(0, 6),
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    status: "open",
    text: textTrimmed.replace(/\r?\n/g, " ")
  };
  const { rawLines } = readLedger(guard, file);
  rawLines.push(renderEntry(entry));
  writeText(guard, file, rawLines.join("\n").replace(/\n*$/, "\n"));
  return entry;
}
function markDone(guard, file, key, now = Date.now()) {
  const { rawLines, entries } = readLedger(guard, file);
  const target = entries.find((e) => e.status === "open" && (e.id === key || e.text.includes(key)));
  if (!target) return null;
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, "0");
  const doneDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const out = rawLines.map((line) => {
    if (line.includes(`#${target.id}] `)) {
      return `- [${doneDate} ${pad(d.getHours())}:${pad(d.getMinutes())}][done][#${target.id}] ${target.text}`;
    }
    return line;
  });
  writeText(guard, file, out.join("\n").replace(/\n*$/, "\n"));
  return target;
}
function scanPending(guard, file, now = Date.now()) {
  const { entries } = readLedger(guard, file);
  return entries.filter((e) => e.status === "open").sort((a, b) => a.date < b.date ? -1 : 1);
}
function pendingOlderThan(guard, file, days, now = Date.now()) {
  const cutoff = new Date(now - days * DAY_MS).toISOString().slice(0, 10);
  return scanPending(guard, file, now).filter((e) => e.date <= cutoff);
}

// src/browse/preference.ts
import path2 from "path";
var DAY_MS2 = 864e5;
var W_MIN = 0.5;
var W_MAX = 2;
var SMOOTH_ADOPTED = 1;
var SMOOTH_DELIVERED = 4;
var DECAY_HALF_LIFE_DAYS = 30;
function preferenceFilePath(dataDir) {
  return path2.join(dataDir, "preference.json");
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
function sanitizeTopicPref(raw) {
  if (!raw || typeof raw !== "object") return null;
  const t = raw;
  if (!Number.isFinite(Number(t.delivered)) || !Number.isFinite(Number(t.adopted))) return null;
  const delivered = Math.floor(num(t.delivered));
  return {
    delivered,
    adopted: Math.min(delivered, Math.floor(num(t.adopted))),
    lastDeliveredAt: num(t.lastDeliveredAt),
    lastAdoptedAt: num(t.lastAdoptedAt)
  };
}
function loadPreference(guard, file) {
  const doc = loadJson(guard, file);
  if (!doc || typeof doc !== "object" || !doc.topics || typeof doc.topics !== "object") {
    return { version: 1, topics: {}, updatedAt: 0 };
  }
  const topics = {};
  for (const [key, raw] of Object.entries(doc.topics)) {
    const t = sanitizeTopicPref(raw);
    if (key && t) topics[key] = t;
  }
  const updatedAt = Number(doc.updatedAt);
  return { version: 1, topics, updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0 };
}
function savePreference(guard, file, state) {
  saveJson(guard, file, state);
}
function recordDelivery(guard, file, opts) {
  const state = loadPreference(guard, file);
  const adopted = new Set(opts.adoptedTopics);
  for (const topic of opts.offeredTopics) {
    if (!topic) continue;
    const t = state.topics[topic] ?? { delivered: 0, adopted: 0, lastDeliveredAt: 0, lastAdoptedAt: 0 };
    t.delivered += 1;
    t.lastDeliveredAt = opts.now;
    if (adopted.has(topic)) {
      t.adopted += 1;
      t.lastAdoptedAt = opts.now;
    }
    state.topics[topic] = t;
  }
  state.updatedAt = opts.now;
  savePreference(guard, file, state);
  return state;
}
function decayed(t, now) {
  const dAgeDays = Math.max(0, now - t.lastDeliveredAt) / DAY_MS2;
  const aAgeDays = Math.max(0, now - t.lastAdoptedAt) / DAY_MS2;
  const dHalf = Math.pow(0.5, dAgeDays / DECAY_HALF_LIFE_DAYS);
  const aHalf = Math.pow(0.5, aAgeDays / DECAY_HALF_LIFE_DAYS);
  return { delivered: t.delivered * dHalf, adopted: t.adopted * aHalf };
}
function preferenceWeight(state, topic, now) {
  const t = state.topics[topic];
  const rate = t ? (() => {
    const d = decayed(t, now);
    return (d.adopted + SMOOTH_ADOPTED) / (d.delivered + SMOOTH_DELIVERED);
  })() : SMOOTH_ADOPTED / SMOOTH_DELIVERED;
  return Math.min(W_MAX, Math.max(W_MIN, rate / (SMOOTH_ADOPTED / SMOOTH_DELIVERED)));
}

// src/browse/browse.ts
import fs from "fs";
import path3 from "path";

// src/core/time-window.ts
var HH_MM = /^(\d{1,2}):(\d{2})$/;
function parseHhMm(text) {
  const m = HH_MM.exec(String(text).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}
function minutesOfDay(now) {
  return now.getHours() * 60 + now.getMinutes();
}
function inHhMmWindow(start, end, mins) {
  const s = parseHhMm(start);
  const e = parseHhMm(end);
  if (s === null || e === null) return false;
  if (s === e) return false;
  return s > e ? mins >= s || mins < e : mins >= s && mins < e;
}

// src/browse/browse.ts
function emptyBrowseState() {
  return { wander: { focusHistory: {}, focusCount: {}, last_wander_at: 0, refillCount: {}, sessionCount: {} } };
}
function browseStatePath(paths) {
  return path3.join(paths.dataDir, "browse.json");
}
function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function loadInterests(paths) {
  const userPath = path3.join(paths.settingsDir, "interests.json");
  if (fs.existsSync(userPath)) return readJsonFile(userPath, { interests: [], _schedule: {} });
  return readJsonFile(path3.join(paths.configDir, "interests.json"), { interests: [], _schedule: {} });
}
function normalizeBrowseState(raw) {
  const out = emptyBrowseState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const r = raw;
  const w = r.wander && typeof r.wander === "object" ? r.wander : {};
  out.wander.focusHistory = numberRecord(w.focusHistory);
  out.wander.focusCount = numberRecord(w.focusCount);
  out.wander.refillCount = numberRecord(w.refillCount);
  out.wander.sessionCount = numberRecord(w.sessionCount);
  if (typeof w.last_wander_at === "number" && Number.isFinite(w.last_wander_at)) out.wander.last_wander_at = w.last_wander_at;
  return out;
}
function numberRecord(v) {
  const out = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, n] of Object.entries(v)) {
    if (typeof n === "number" && Number.isFinite(n)) out[k] = n;
  }
  return out;
}
function loadState(guard, paths) {
  return normalizeBrowseState(loadJson(guard, browseStatePath(paths)));
}
function resolveSchedule(interests, policy) {
  const sc = interests._schedule ?? {};
  return {
    windows: sc.windows?.length ? sc.windows : policy.browse.windows,
    minIntervalHours: sc.min_interval_hours ?? policy.browse.minIntervalHours,
    maxSeedsPerFocus: sc.max_seeds_per_focus ?? policy.browse.maxSeedsPerVisit,
    dailySessions: sc.daily_sessions ?? 0,
    focusPerSession: Math.max(1, sc.focus_per_session ?? 1),
    focusCooldownDays: sc.focus_cooldown_days ?? 3
  };
}
function inWanderWindow(now, windows) {
  const mins = minutesOfDay(now);
  for (const w of windows) {
    if (inHhMmWindow(w.start, w.end, mins)) return `${w.start}-${w.end}`;
  }
  return null;
}
function onCooldown(state, focus, cooldownDays, now) {
  const last = state.wander.focusHistory[focus] ?? 0;
  return last > now - cooldownDays * 864e5;
}
var STARVATION_DAYS = 14;
function pickFocus(state, interests, now, pref) {
  const sc = interests._schedule ?? {};
  const cooldown = sc.focus_cooldown_days ?? 3;
  const pool = (interests.interests ?? []).filter((t) => !onCooldown(state, t, cooldown, now));
  if (pool.length === 0) return null;
  if (!pref) {
    pool.sort((a, b) => (state.wander.focusHistory[a] ?? 0) - (state.wander.focusHistory[b] ?? 0));
    return pool[0];
  }
  const age = (t) => now - (state.wander.focusHistory[t] ?? 0);
  const starved = pool.filter((t) => age(t) >= STARVATION_DAYS * 864e5);
  if (starved.length > 0) {
    starved.sort((a, b) => age(b) - age(a));
    return starved[0];
  }
  const effAge = (t) => age(t) * preferenceWeight(pref, t, now);
  pool.sort((a, b) => effAge(b) - effAge(a));
  return pool[0];
}
function adviseWander(guard, paths, policy, now = /* @__PURE__ */ new Date()) {
  const state = loadState(guard, paths);
  const interests = loadInterests(paths);
  const sched = resolveSchedule(interests, policy);
  const budget = { maxSeeds: sched.maxSeedsPerFocus };
  const win = inWanderWindow(now, sched.windows);
  if (!win) {
    const hh = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    return { focus: null, query: null, skipped: `window(now=${hh})`, ...budget };
  }
  const today = localDayKey(now);
  const sessionsToday = state.wander.sessionCount?.[today] ?? 0;
  if (sched.dailySessions > 0 && sessionsToday >= sched.dailySessions) {
    return { focus: null, query: null, skipped: `daily-sessions(${sessionsToday})`, ...budget };
  }
  const minGap = sched.minIntervalHours * 36e5;
  if (now.getTime() - state.wander.last_wander_at < minGap) {
    return { focus: null, query: null, skipped: "min-interval", ...budget };
  }
  const pref = loadPreference(guard, preferenceFilePath(paths.dataDir));
  const pool = interests.interests ?? [];
  const candidates = [];
  for (let i = 0; i < sched.focusPerSession; i++) {
    const rest = pool.filter((t) => !candidates.includes(t));
    if (rest.length === 0) break;
    const picked = pickFocus(state, { ...interests, interests: rest }, now.getTime(), pref);
    if (!picked) break;
    candidates.push(picked);
  }
  if (candidates.length === 0) return { focus: null, query: null, skipped: "no-focus", ...budget };
  return { focus: candidates[0], query: `${candidates[0]} 2026 \u6700\u65B0`, skipped: null, candidates, ...budget };
}
function completeWander(guard, paths, focus, now = Date.now(), opts = {}) {
  const state = loadState(guard, paths);
  state.wander.focusHistory[focus] = now;
  state.wander.focusCount[focus] = (state.wander.focusCount[focus] ?? 0) + 1;
  state.wander.last_wander_at = now;
  if (!opts.refill) {
    const day = localDayKey(new Date(now));
    state.wander.sessionCount = state.wander.sessionCount ?? {};
    state.wander.sessionCount[day] = (state.wander.sessionCount[day] ?? 0) + 1;
  }
  let refillsToday;
  if (opts.refill) {
    const today = localDayKey(new Date(now));
    state.wander.refillCount = state.wander.refillCount ?? {};
    state.wander.refillCount[today] = (state.wander.refillCount[today] ?? 0) + 1;
    refillsToday = state.wander.refillCount[today];
  }
  saveJson(guard, browseStatePath(paths), state);
  return { focus, count: state.wander.focusCount[focus], ...refillsToday === void 0 ? {} : { refillsToday } };
}
function localDayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
var REFILL_TOPIC_THRESHOLD = 4;
var REFILL_MAX_PER_DAY = 2;
function adviseRefillWander(guard, paths, policy, now = /* @__PURE__ */ new Date()) {
  const state = loadState(guard, paths);
  const today = localDayKey(now);
  const refillsToday = state.wander.refillCount?.[today] ?? 0;
  const topicCount = activeSeeds(loadPool(guard, seedsFilePath(paths.dataDir))).filter((s) => normalizeCategory(s.category) === "topic").length;
  if (refillsToday >= REFILL_MAX_PER_DAY) {
    return { focus: null, query: null, skipped: `refill-daily-cap(${refillsToday})`, topicCount, refillsToday };
  }
  if (topicCount > REFILL_TOPIC_THRESHOLD) {
    return { focus: null, query: null, skipped: `topic-stock-ok(${topicCount})`, topicCount, refillsToday };
  }
  const interests = loadInterests(paths);
  const focus = pickFocus(state, interests, now.getTime(), loadPreference(guard, preferenceFilePath(paths.dataDir)));
  if (!focus) {
    return { focus: null, query: null, skipped: "no-focus", topicCount, refillsToday };
  }
  return { focus, query: `${focus} 2026 \u6700\u65B0`, skipped: null, topicCount, refillsToday };
}
function browseStatus(guard, paths) {
  return loadState(guard, paths);
}

// src/notify/notify.ts
import path4 from "path";

// src/core/ps.ts
import { execFile } from "child_process";
function runPowerShell(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args],
      { timeout: timeoutMs, encoding: "utf8", windowsHide: true },
      (err, stdout, stderr) => {
        const code = err?.code;
        const status = err ? typeof code === "number" ? code : 1 : 0;
        resolve({ status, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      }
    );
    child.on("error", () => {
    });
  });
}
function runPowerShellFile(script, args, timeoutMs) {
  return runPowerShell(["-File", script, ...args], timeoutMs);
}

// src/notify/notify.ts
async function runNotify(paths, args) {
  const r = await runPowerShellFile(path4.join(paths.assetsDir, "notify.ps1"), args, 2e4);
  return { status: r.status, out: `${r.stdout}${r.stderr}`.trim() };
}
async function ensureRegistered(paths) {
  const check = await runNotify(paths, ["-Check"]);
  if (/REGISTERED: yes/.test(check.out)) return true;
  const reg = await runNotify(paths, ["-RegisterOnly"]);
  return reg.status === 0;
}
async function sendNewMessageHint(paths) {
  const r = await runNotify(paths, ["-Title", "Heartbeat", "-Message", "\u6709\u65B0\u6D88\u606F"]);
  return r.status === 0 && /TOAST_SENT/.test(r.out);
}
async function sendWeeklyReadyHint(paths) {
  const r = await runNotify(paths, ["-Title", "\u5FC3\u8DF3\u5468\u62A5", "-Message", "\u672C\u671F\u5468\u62A5\u5DF2\u751F\u6210"]);
  return r.status === 0 && /TOAST_SENT/.test(r.out);
}

// src/weekly/report.ts
import fs2 from "fs";
import path5 from "path";
var WEEKLY_INTERVAL_MS = 7 * 864e5;
function weeklyDirPath(dataDir) {
  return path5.join(dataDir, "weekly");
}
function stateFilePath(dataDir) {
  return path5.join(weeklyDirPath(dataDir), "state.json");
}
function reportFileName(endIso) {
  return `report-${endIso.slice(0, 10)}.json`;
}
function lastWeeklyGeneratedAt(guard, dataDir) {
  const file = stateFilePath(dataDir);
  let raw;
  try {
    raw = fs2.readFileSync(guard.assert(file), "utf8");
  } catch {
    return 0;
  }
  try {
    const parsed = JSON.parse(raw);
    const n = Number(parsed.lastGeneratedAt);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
  }
  try {
    appendAuditLine(path5.join(workspace().logsDir, "heartbeat.jsonl"), {
      event: "weekly_anchor_corrupt",
      file: path5.basename(file),
      bytes: Buffer.byteLength(raw)
    });
  } catch {
  }
  try {
    return fs2.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}
function weeklyDue(guard, dataDir, now = Date.now()) {
  const last = lastWeeklyGeneratedAt(guard, dataDir);
  return now - last >= WEEKLY_INTERVAL_MS;
}
function ensureWeeklyAnchor(guard, dataDir, now = Date.now()) {
  if (lastWeeklyGeneratedAt(guard, dataDir) > 0) return false;
  fs2.mkdirSync(weeklyDirPath(dataDir), { recursive: true });
  atomicWriteJsonSync(stateFilePath(dataDir), { lastGeneratedAt: now });
  return true;
}
function saveWeeklyReport(guard, dataDir, report) {
  const dir = weeklyDirPath(dataDir);
  fs2.mkdirSync(dir, { recursive: true });
  const file = path5.join(dir, reportFileName(report.end));
  saveEncryptedText(guard, file, JSON.stringify(report, null, 1));
  atomicWriteJsonSync(stateFilePath(dataDir), { lastGeneratedAt: Date.parse(report.generatedAt) });
  return file;
}
function listWeeklyReports(guard, dataDir) {
  const out = [];
  try {
    for (const file of fs2.readdirSync(weeklyDirPath(dataDir))) {
      if (!/^report-\d{4}-\d{2}-\d{2}\.json$/.test(file)) continue;
      const rep = readWeeklyReport(guard, dataDir, file);
      if (!rep) continue;
      out.push({ file, start: rep.start, end: rep.end, generatedAt: rep.generatedAt, source: rep.source });
    }
  } catch {
  }
  return out.sort((a, b) => a.end < b.end ? 1 : -1);
}
function readWeeklyReport(guard, dataDir, file) {
  if (!/^report-\d{4}-\d{2}-\d{2}\.json$/.test(file)) return null;
  try {
    const raw = loadEncryptedText(guard, path5.join(weeklyDirPath(dataDir), file));
    if (!raw) return null;
    const rep = JSON.parse(raw);
    if (typeof rep.text !== "string") return null;
    return rep;
  } catch {
    return null;
  }
}
function buildWeeklyPrompt(facts) {
  return [
    "\u4F60\u662F\u5FC3\u8DF3\u63D2\u4EF6\u7684\u540E\u53F0\u62A5\u544A\u5668\u3002\u6839\u636E\u4E0B\u9762\u7684\u672C\u5468\u4E8B\u5B9E\u6E05\u5355\uFF0C\u7528\u4E2D\u6587\u5199\u4E00\u4EFD\u5468\u62A5\u6B63\u6587\u3002",
    "\u89C4\u5219\uFF1A",
    "- \u53D9\u8FF0\u8005\u81EA\u79F0\u300C\u5FC3\u8DF3\u300D\u2014\u2014\u8FD9\u662F\u63D2\u4EF6\u540E\u53F0\uFF0C\u4E0D\u662F\u4EFB\u4F55\u4F1A\u8BDD\u91CC\u7684 agent\uFF1B\u7EDD\u4E0D\u80FD\u4EE5\u4F1A\u8BDD agent \u7684\u8EAB\u4EFD\u6216\u4EBA\u683C\u81EA\u79F0\u3002",
    "- \u53EA\u62A5\u544A\u4E8B\u5B9E\u6E05\u5355\u91CC\u6709\u7684\u5185\u5BB9\uFF1B\u67D0\u4E00\u8282\u6CA1\u6709\u6570\u636E\u5C31\u6574\u8282\u8DF3\u8FC7\uFF0C\u4E0D\u8981\u7F16\u9020\u3001\u4E0D\u8981\u51D1\u6570\u3002",
    "- \u8BED\u6C14\u5E73\u5B9E\u4E2D\u6027\uFF0C\u4E0D\u7528\u611F\u53F9\u53F7\uFF1B\u7BC7\u5E45\u4E0D\u8D85\u8FC7 250 \u5B57\u3002",
    "- \u5F85\u529E\u79EF\u538B\u90A3\u4E00\u8282\u7528\u5546\u91CF\u7684\u8BED\u6C14\u63D0\u4E00\u53E5\uFF0C\u4E0D\u50AC\u4FC3\u3002",
    "- \u76F4\u63A5\u8F93\u51FA\u5468\u62A5\u6B63\u6587\uFF0C\u4E0D\u8981\u8F93\u51FA\u89E3\u91CA\u3001\u6807\u9898\u6216 JSON\u3002",
    "",
    "\u672C\u5468\u4E8B\u5B9E\uFF08JSON\uFF09\uFF1A",
    JSON.stringify(facts, null, 1)
  ].join("\n");
}
function renderTemplateReport(facts) {
  const d = (iso) => iso.slice(0, 10);
  const lines = [`\u672C\u5468\uFF08${d(facts.windowStart)} ~ ${d(facts.windowEnd)}\uFF09`];
  lines.push(`\u8868\u8FBE ${facts.spoken} \u6B21\uFF0C\u9759\u9ED8 ${facts.silent} \u6B21\u3002`);
  if (facts.silentTopReasons.length > 0) {
    lines.push(`\u9759\u9ED8\u4E3B\u56E0\uFF1A${facts.silentTopReasons.map((r) => `${r.reason}\uFF08${r.count}\uFF09`).join("\u3001")}\u3002`);
  }
  if (facts.profileAdds.length > 0) {
    lines.push(`\u65B0\u8BA4\u8BC6 ${facts.profileAdds.length} \u6761\uFF1A${facts.profileAdds.map((a) => a.content).join("\uFF1B")}\u3002`);
  }
  if (facts.ledger.added.length > 0 || facts.ledger.done.length > 0) {
    const parts = [];
    if (facts.ledger.added.length > 0) parts.push(`\u65B0\u589E\u5F85\u529E\uFF1A${facts.ledger.added.join("\u3001")}`);
    if (facts.ledger.done.length > 0) parts.push(`\u5DF2\u89E3\u51B3\uFF1A${facts.ledger.done.join("\u3001")}`);
    lines.push(`${parts.join("\uFF1B")}\u3002`);
  }
  if (facts.ledger.stale.length > 0) {
    lines.push(`\u6302\u4E86\u5F88\u4E45\uFF1A${facts.ledger.stale.map((s) => `${s.text}\uFF08${s.days} \u5929\uFF09`).join("\u3001")}\u2014\u2014\u8981\u5220\u6389\u8FD8\u662F\u7EE7\u7EED\u6302\u7740\uFF1F`);
  }
  if (facts.seeds.added.length > 0) {
    lines.push(`\u7D20\u6750\u6C60\u65B0\u589E ${facts.seeds.added.length} \u6761\uFF0C\u5DF2\u6D88\u8D39 ${facts.seeds.consumed.length} \u6761\u3002`);
  }
  if (facts.seeds.waiting.length > 0) {
    lines.push(`\u8FD8\u6CA1\u804A\u8FC7\u7684\u7D20\u6750\uFF1A${facts.seeds.waiting.join("\u3001")}\u3002`);
  }
  if (facts.reports.total > 0) {
    const reasonPart = facts.reports.reasons.length > 0 ? `\uFF08${facts.reports.reasons.map((r) => `${r.reason} ${r.count} \u6B21`).join("\u3001")}\uFF09` : "";
    lines.push(`\u6295\u9012\u62A5\u8D26 ${facts.reports.total} \u6B21\uFF1A\u7528\u7D20\u6750 ${facts.reports.material}\u3001\u8BF4\u771F\u5FC3\u8BDD ${facts.reports.heartfelt}\u3001\u6CA1\u8BF4\u8BDD ${facts.reports.silent}${reasonPart}\u3002`);
  }
  if (facts.reports.missing > 0) {
    lines.push(`\u53E6\u6709 ${facts.reports.missing} \u6B21\u6295\u9012\u6CA1\u7B49\u5230\u62A5\u8D26\uFF08\u8FD9\u90E8\u5206\u6CA1\u7B97\u8FDB\u504F\u597D\u7EDF\u8BA1\uFF09\u3002`);
  }
  if (facts.peakHours.length > 0) {
    lines.push(`\u6D3B\u8DC3\u9AD8\u5CF0\uFF1A${facts.peakHours.join("\u3001")}\u3002`);
  }
  return lines.join("\n");
}

export {
  ledgerFilePath,
  readLedger,
  appendEntry,
  markDone,
  scanPending,
  pendingOlderThan,
  runPowerShell,
  runPowerShellFile,
  minutesOfDay,
  inHhMmWindow,
  preferenceFilePath,
  recordDelivery,
  loadInterests,
  adviseWander,
  completeWander,
  adviseRefillWander,
  browseStatus,
  ensureRegistered,
  sendNewMessageHint,
  sendWeeklyReadyHint,
  weeklyDirPath,
  weeklyDue,
  ensureWeeklyAnchor,
  saveWeeklyReport,
  listWeeklyReports,
  readWeeklyReport,
  buildWeeklyPrompt,
  renderTemplateReport
};
//# sourceMappingURL=chunk-WRJCINZ7.js.map