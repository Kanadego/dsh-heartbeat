import {
  activeSeeds,
  loadPool,
  normalizeCategory,
  seedsFilePath
} from "./chunk-PQTSXW4F.js";
import {
  atomicWriteJsonSync
} from "./chunk-VIZNIQLK.js";
import {
  loadEncryptedText,
  loadJson,
  readText,
  saveEncryptedText,
  saveJson,
  writeText
} from "./chunk-IFTFDHZX.js";

// src/core/path-guard.ts
import fs from "fs";
import path from "path";
var PathOutsideWorkspaceError = class extends Error {
  constructor(target, workspace) {
    super(`path outside workspace: "${target}" (workspace: "${workspace}")`);
    this.name = "PathOutsideWorkspaceError";
  }
};
function canonicalize(target) {
  const abs = path.resolve(target);
  try {
    return fs.realpathSync(abs);
  } catch {
    const tail = [];
    let dir = abs;
    for (; ; ) {
      const base = path.basename(dir);
      const parent = path.dirname(dir);
      if (parent === dir) {
        throw new Error(`cannot canonicalize "${target}": no existing ancestor`);
      }
      tail.push(base);
      dir = parent;
      try {
        const realDir = fs.realpathSync(dir);
        return path.join(realDir, ...tail.reverse());
      } catch {
        continue;
      }
    }
  }
}
function isInsideWorkspace(workspaceCanon, targetCanon) {
  const norm = (p) => {
    let n = path.normalize(p).toLowerCase();
    if (!n.endsWith(path.sep)) n += path.sep;
    return n;
  };
  const w = norm(workspaceCanon);
  const t = norm(targetCanon);
  return t === w || t.startsWith(w);
}
function createPathGuard(workspaceDir) {
  const workspace = canonicalize(workspaceDir);
  const guard = {
    workspace,
    check(target) {
      const canon = canonicalize(target);
      return isInsideWorkspace(workspace, canon) ? canon : null;
    },
    assert(target) {
      const canon = guard.check(target);
      if (canon === null) throw new PathOutsideWorkspaceError(target, workspace);
      return canon;
    }
  };
  return guard;
}

// src/config/schema.ts
var HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function fail(msg) {
  throw new Error(`policy: ${msg}`);
}
function assertPolicy(input) {
  if (!isPlainObject(input)) fail("root must be an object");
  const p = input;
  const hb = p.heartbeat;
  if (!isPlainObject(hb)) fail("heartbeat missing");
  if (typeof hb.intervalMin !== "number" || hb.intervalMin < 1 || hb.intervalMin > 1440) {
    fail("heartbeat.intervalMin must be a number in [1, 1440]");
  }
  if (typeof hb.idleMode !== "boolean") fail("heartbeat.idleMode must be boolean");
  if (typeof hb.archiveRotatedHome !== "boolean") fail("heartbeat.archiveRotatedHome must be boolean");
  const g = p.gate;
  if (!isPlainObject(g)) fail("gate missing");
  if (typeof g.maxDailySend !== "number" || g.maxDailySend < 0) fail("gate.maxDailySend must be >= 0");
  if (typeof g.cooldownMinutes !== "number" || g.cooldownMinutes < 0) fail("gate.cooldownMinutes must be >= 0");
  const qh = g.quietHours;
  if (!isPlainObject(qh)) fail("gate.quietHours missing");
  if (typeof qh.start !== "string" || !HHMM.test(qh.start) || typeof qh.end !== "string" || !HHMM.test(qh.end)) {
    fail('gate.quietHours must be {start:"HH:MM", end:"HH:MM"}');
  }
  const b = p.browse;
  if (!isPlainObject(b)) fail("browse missing");
  if (!Array.isArray(b.windows) || b.windows.length === 0) fail("browse.windows must be a non-empty array");
  for (const w of b.windows) {
    if (!isPlainObject(w)) fail("browse.windows entries must be objects");
    if (typeof w.start !== "string" || !HHMM.test(w.start) || typeof w.end !== "string" || !HHMM.test(w.end)) {
      fail('browse.windows entries must be {start:"HH:MM", end:"HH:MM"}');
    }
  }
  if (typeof b.minIntervalHours !== "number" || b.minIntervalHours <= 0) fail("browse.minIntervalHours must be > 0");
  if (typeof b.maxSeedsPerVisit !== "number" || b.maxSeedsPerVisit < 1) fail("browse.maxSeedsPerVisit must be >= 1");
  const s = p.seeds;
  if (!isPlainObject(s)) fail("seeds missing");
  if (typeof s.maxActive !== "number" || s.maxActive < 1) fail("seeds.maxActive must be >= 1");
  if (!isPlainObject(s.ttlDays)) fail("seeds.ttlDays missing");
  for (const k of ["news", "fandom", "scene", "promise"]) {
    if (typeof s.ttlDays[k] !== "number") fail(`seeds.ttlDays.${k} missing`);
  }
  if (typeof s.coldBenchDays !== "number") fail("seeds.coldBenchDays missing");
  if (typeof s.archiveCap !== "number" || s.archiveCap < 1) fail("seeds.archiveCap must be >= 1");
  if (typeof s.retireAfterUsed !== "number" || s.retireAfterUsed < 1) fail("seeds.retireAfterUsed must be >= 1");
  if (!isPlainObject(s.scoreWeights)) fail("seeds.scoreWeights missing");
  const pr = p.profile;
  if (!isPlainObject(pr)) fail("profile missing");
  const c = pr.consolidation;
  if (!isPlainObject(c)) fail("profile.consolidation missing");
  if (typeof c.minIntervalHours !== "number" || typeof c.inboxBacklog !== "number") fail("profile.consolidation fields missing");
  if (typeof pr.partitionCap !== "number" || pr.partitionCap < 1) fail("profile.partitionCap must be >= 1");
  if (typeof pr.maxOpsPerRun !== "number" || pr.maxOpsPerRun < 1) fail("profile.maxOpsPerRun must be >= 1");
  const cc = pr.confidenceCap;
  if (!isPlainObject(cc)) fail("profile.confidenceCap missing");
  if (typeof cc.chat !== "number" || typeof cc.screen !== "number" || typeof cc.browse !== "number") {
    fail("profile.confidenceCap fields missing");
  }
  if (typeof pr.volatileDays !== "number" || pr.volatileDays < 1) fail("profile.volatileDays must be >= 1");
  if (typeof pr.stableLowActivityDays !== "number" || pr.stableLowActivityDays < 1) fail("profile.stableLowActivityDays must be >= 1");
  if (typeof pr.psyEnabled !== "boolean") fail("profile.psyEnabled must be boolean");
  const ob = p.observe;
  if (!isPlainObject(ob)) fail("observe missing");
  if (typeof ob.maxChars !== "number" || ob.maxChars < 20 || ob.maxChars > 2e3) fail("observe.maxChars must be in [20, 2000]");
  if (typeof ob.perBeat !== "number" || ob.perBeat < 1 || ob.perBeat > 100) fail("observe.perBeat must be in [1, 100]");
  if (!isPlainObject(p.weekly)) fail("weekly missing");
  if (typeof p.weekly.enabled !== "boolean") fail("weekly.enabled must be boolean");
  const r = p.retention;
  if (!isPlainObject(r)) fail("retention missing");
  if (typeof r.envPulseHours !== "number" || typeof r.decisionLogDays !== "number") fail("retention fields missing");
}
function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === void 0 ? base : override;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = v === void 0 ? base[k] : deepMerge(base[k], v);
  }
  return out;
}

// src/config/load.ts
import fs2 from "fs";
import path2 from "path";
var USER_POLICY_FILE = "policy.json";
function loadPolicy(guard, configDir, settingsDir) {
  const factoryPath = path2.join(configDir, "policy.json");
  let factoryRaw;
  try {
    factoryRaw = JSON.parse(fs2.readFileSync(factoryPath, "utf8"));
  } catch (e) {
    throw new Error(`factory policy unreadable at ${factoryPath}: ${String(e)}`);
  }
  assertPolicy(factoryRaw);
  const userPath = guard.assert(path2.join(settingsDir, USER_POLICY_FILE));
  let merged = factoryRaw;
  if (fs2.existsSync(userPath)) {
    try {
      const userRaw = JSON.parse(fs2.readFileSync(userPath, "utf8"));
      merged = deepMerge(factoryRaw, userRaw);
    } catch (e) {
      throw new Error(`user policy layer unparseable at ${userPath}: ${String(e)}`);
    }
  }
  assertPolicy(merged);
  return merged;
}
function updateUserPolicy(guard, settingsDir, patch) {
  const userPath = guard.assert(path2.join(settingsDir, USER_POLICY_FILE));
  let user = {};
  try {
    user = JSON.parse(fs2.readFileSync(userPath, "utf8"));
    if (!user || typeof user !== "object" || Array.isArray(user)) user = {};
  } catch {
    user = {};
  }
  const merged = deepMerge(user, patch);
  fs2.mkdirSync(path2.dirname(userPath), { recursive: true });
  fs2.writeFileSync(userPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
  return merged;
}

// src/ledger/ledger.ts
import path3 from "path";
import { randomUUID } from "crypto";
var DAY_MS = 864e5;
function ledgerFilePath(dataDir) {
  return path3.join(dataDir, "ledger.md");
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

// src/browse/browse.ts
import fs3 from "fs";
import path5 from "path";

// src/browse/preference.ts
import path4 from "path";
var DAY_MS2 = 864e5;
var W_MIN = 0.5;
var W_MAX = 2;
var SMOOTH_ADOPTED = 1;
var SMOOTH_DELIVERED = 4;
var DECAY_HALF_LIFE_DAYS = 30;
function preferenceFilePath(dataDir) {
  return path4.join(dataDir, "preference.json");
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
var WATCH_THROTTLE_MS = 6 * 36e5;
var UA = { "User-Agent": "dsh-heartbeat/2.0 (+local; personal companion)" };
function emptyBrowseState() {
  return { targets: {}, last_check_at: 0, wander: { focusHistory: {}, focusCount: {}, last_wander_at: 0, refillCount: {} } };
}
function browseStatePath(paths) {
  return path5.join(paths.dataDir, "browse.json");
}
function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs3.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function loadInterests(paths) {
  const userPath = path5.join(paths.settingsDir, "interests.json");
  if (fs3.existsSync(userPath)) return readJsonFile(userPath, { interests: [], _schedule: {} });
  return readJsonFile(path5.join(paths.configDir, "interests.json"), { interests: [], _schedule: {} });
}
function loadWatchlist(paths) {
  const userPath = path5.join(paths.settingsDir, "watchlist.json");
  if (fs3.existsSync(userPath)) return readJsonFile(userPath, { targets: [] });
  return readJsonFile(path5.join(paths.configDir, "watchlist.json"), { targets: [] });
}
function loadState(guard, paths) {
  return loadJson(guard, browseStatePath(paths)) ?? emptyBrowseState();
}
async function checkNpm(fetcher, name) {
  const r = await fetcher(`https://registry.npmjs.org/${name}/latest`, { headers: UA });
  if (!r.ok) throw new Error(`npm ${r.status}`);
  const j = await r.json();
  if (!j.version) throw new Error("npm: no version");
  return { version: j.version, seen: `npm:${j.version}` };
}
async function checkGithub(fetcher, repo) {
  const r = await fetcher(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { ...UA, Accept: "application/vnd.github+json" }
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`gh ${r.status}`);
  const j = await r.json();
  if (!j.tag_name) throw new Error("gh: no tag");
  return { version: j.tag_name, seen: `gh:${j.tag_name}`, title: j.name || "" };
}
async function checkWatchlist(guard, paths, opts = {}, now = Date.now()) {
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const state = loadState(guard, paths);
  if (opts.throttleOk !== true && now - state.last_check_at < WATCH_THROTTLE_MS) {
    return { items: [], errors: [], checked: 0 };
  }
  const watchlist = loadWatchlist(paths);
  const report = { items: [], errors: [], checked: 0 };
  for (const t of watchlist.targets ?? []) {
    report.checked += 1;
    try {
      const info = t.type === "npm" && t.name ? await checkNpm(fetcher, t.name) : t.type === "github" && t.repo ? await checkGithub(fetcher, t.repo) : null;
      if (!info) continue;
      const prev = state.targets[t.id];
      if (prev && prev.seen !== info.seen) {
        const title = info.title ? `\uFF08${info.title.slice(0, 60)}\uFF09` : "";
        report.items.push({
          text: `${t.note || t.id} \u6709\u66F4\u65B0\uFF1A${prev.version} -> ${info.version}${title}`,
          topic: `watch:${t.id}`,
          tag: "news",
          source: "browse",
          confidence: 0.4
        });
      }
      state.targets[t.id] = info;
    } catch (e) {
      report.errors.push(`${t.id}: ${String(e)}`);
    }
  }
  state.last_check_at = now;
  saveJson(guard, browseStatePath(paths), state);
  return report;
}
function inWanderWindow(now, windows) {
  const hm = now.getHours() * 60 + now.getMinutes();
  for (const w of windows) {
    const [sh, sm] = w.start.split(":").map(Number);
    const [eh, em] = w.end.split(":").map(Number);
    if (hm >= sh * 60 + sm && hm <= eh * 60 + em) return `${w.start}-${w.end}`;
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
  const windows = interests._schedule?.windows?.length ? interests._schedule.windows : policy.browse.windows;
  const win = inWanderWindow(now, windows);
  if (!win) {
    const hh = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    return { focus: null, query: null, skipped: `window(now=${hh})` };
  }
  const minGap = policy.browse.minIntervalHours * 36e5;
  if (now.getTime() - state.wander.last_wander_at < minGap) {
    return { focus: null, query: null, skipped: "min-interval" };
  }
  const focus = pickFocus(state, interests, now.getTime(), loadPreference(guard, preferenceFilePath(paths.dataDir)));
  if (!focus) return { focus: null, query: null, skipped: "no-focus" };
  return { focus, query: `${focus} 2026 \u6700\u65B0`, skipped: null };
}
function completeWander(guard, paths, focus, now = Date.now(), opts = {}) {
  const state = loadState(guard, paths);
  state.wander.focusHistory[focus] = now;
  state.wander.focusCount[focus] = (state.wander.focusCount[focus] ?? 0) + 1;
  state.wander.last_wander_at = now;
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
import { spawnSync } from "child_process";
import path6 from "path";
function runNotify(paths, args) {
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path6.join(paths.assetsDir, "notify.ps1"), ...args],
    { timeout: 2e4, encoding: "utf8" }
  );
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}
function ensureRegistered(paths) {
  const check = runNotify(paths, ["-Check"]);
  if (/REGISTERED: yes/.test(check.out)) return true;
  const reg = runNotify(paths, ["-RegisterOnly"]);
  return reg.status === 0;
}
function sendNewMessageHint(paths) {
  const r = runNotify(paths, ["-Title", "Heartbeat", "-Message", "\u6709\u65B0\u6D88\u606F"]);
  return r.status === 0 && /TOAST_SENT/.test(r.out);
}
function sendWeeklyReadyHint(paths) {
  const r = runNotify(paths, ["-Title", "\u5FC3\u8DF3\u5468\u62A5", "-Message", "\u672C\u671F\u5468\u62A5\u5DF2\u751F\u6210"]);
  return r.status === 0 && /TOAST_SENT/.test(r.out);
}

// src/weekly/report.ts
import fs4 from "fs";
import path7 from "path";
var WEEKLY_INTERVAL_MS = 7 * 864e5;
function weeklyDirPath(dataDir) {
  return path7.join(dataDir, "weekly");
}
function stateFilePath(dataDir) {
  return path7.join(weeklyDirPath(dataDir), "state.json");
}
function reportFileName(endIso) {
  return `report-${endIso.slice(0, 10)}.json`;
}
function lastWeeklyGeneratedAt(guard, dataDir) {
  try {
    const raw = JSON.parse(fs4.readFileSync(guard.assert(stateFilePath(dataDir)), "utf8"));
    return Number(raw.lastGeneratedAt) || 0;
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
  fs4.mkdirSync(weeklyDirPath(dataDir), { recursive: true });
  atomicWriteJsonSync(stateFilePath(dataDir), { lastGeneratedAt: now });
  return true;
}
function saveWeeklyReport(guard, dataDir, report) {
  const dir = weeklyDirPath(dataDir);
  fs4.mkdirSync(dir, { recursive: true });
  const file = path7.join(dir, reportFileName(report.end));
  saveEncryptedText(guard, file, JSON.stringify(report, null, 1));
  atomicWriteJsonSync(stateFilePath(dataDir), { lastGeneratedAt: Date.parse(report.generatedAt) });
  return file;
}
function listWeeklyReports(guard, dataDir) {
  const out = [];
  try {
    for (const file of fs4.readdirSync(weeklyDirPath(dataDir))) {
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
    const raw = loadEncryptedText(guard, path7.join(weeklyDirPath(dataDir), file));
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

// src/core/preset-install.ts
import fs5 from "fs";
import os from "os";
import path8 from "path";
import { fileURLToPath } from "url";
var COMPOSITION_FILE = "agent.cordis.yml";
var METADATA_FILE = "preset.yml";
var BUNDLED_PRESET_ID = "heartbeat";
function bundledPresetDir(moduleUrl, id = BUNDLED_PRESET_ID) {
  let dir;
  try {
    dir = path8.dirname(fileURLToPath(moduleUrl));
  } catch {
    return void 0;
  }
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = path8.join(dir, "assets", "presets", id);
    if (fs5.existsSync(path8.join(candidate, COMPOSITION_FILE))) return candidate;
    const parent = path8.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return void 0;
}
function userPresetRoot(roots) {
  const found = roots?.find(
    (root) => root?.trust === "user" && typeof root.path === "string" && root.path.length > 0
  );
  return found?.path === void 0 ? void 0 : path8.resolve(found.path);
}
function conventionalUserPresetRoot(env = process.env, home = os.homedir()) {
  const override = env.DSH_HOME?.trim();
  const root = override && override.length > 0 ? override : path8.join(home, ".dsh");
  return path8.join(root, ".agent-presets");
}
function installBundledPreset(options) {
  const id = options.id && options.id.length > 0 ? options.id : BUNDLED_PRESET_ID;
  if (options.enabled === false) {
    return { action: "skipped-disabled", id, detail: "installPreset=false" };
  }
  const bundledDir = bundledPresetDir(options.moduleUrl, BUNDLED_PRESET_ID);
  if (id !== BUNDLED_PRESET_ID) {
    return {
      action: "skipped-custom-id",
      id,
      ...bundledDir === void 0 ? {} : { bundledDir },
      detail: `only "${BUNDLED_PRESET_ID}" ships with the plugin; "${id}" is yours to provide`
    };
  }
  if (bundledDir === void 0) {
    return {
      action: "error",
      id,
      detail: "bundled template not found next to the plugin (assets/presets/heartbeat)"
    };
  }
  const root = options.root ?? (options.rosterKnown ? void 0 : conventionalUserPresetRoot());
  if (root === void 0) {
    return {
      action: "skipped-no-root",
      id,
      bundledDir,
      detail: "the roster mounts no user preset root (includeUserRoot=false)"
    };
  }
  const dir = path8.join(root, id);
  const composition = path8.join(dir, COMPOSITION_FILE);
  try {
    if (fs5.existsSync(composition)) {
      if (options.force !== true) {
        const drifted = !sameBytes(composition, path8.join(bundledDir, COMPOSITION_FILE));
        return {
          action: "exists",
          id,
          dir,
          bundledDir,
          detail: drifted ? "kept as-is (differs from the bundled template)" : "kept as-is"
        };
      }
      fs5.copyFileSync(path8.join(bundledDir, COMPOSITION_FILE), composition);
      return {
        action: "restored",
        id,
        dir,
        bundledDir,
        detail: "composition replaced from the bundled template"
      };
    }
    const existed = fs5.existsSync(dir);
    fs5.mkdirSync(dir, { recursive: true });
    fs5.copyFileSync(path8.join(bundledDir, COMPOSITION_FILE), composition);
    const metadata = path8.join(dir, METADATA_FILE);
    if (!fs5.existsSync(metadata)) fs5.copyFileSync(path8.join(bundledDir, METADATA_FILE), metadata);
    return {
      action: existed ? "repaired" : "created",
      id,
      dir,
      bundledDir,
      detail: existed ? "directory existed without a composition file (it occupied the id as a broken row)" : void 0
    };
  } catch (error) {
    return { action: "error", id, dir, bundledDir, detail: String(error).slice(0, 200) };
  }
}
function describeInstall(result) {
  const where = result.dir === void 0 ? "" : ` (${result.dir})`;
  const why = result.detail === void 0 ? "" : ` \u2014 ${result.detail}`;
  return `preset ${result.id} ${result.action}${where}${why}`;
}
function presetStatus(moduleUrl, id = BUNDLED_PRESET_ID, root = conventionalUserPresetRoot()) {
  const dir = path8.join(root, id);
  const bundledDir = bundledPresetDir(moduleUrl, id);
  const installed = fs5.existsSync(path8.join(dir, COMPOSITION_FILE));
  return {
    id,
    dir,
    ...bundledDir === void 0 ? {} : { bundledDir },
    installed,
    compositionMatches: installed && bundledDir !== void 0 && sameBytes(path8.join(dir, COMPOSITION_FILE), path8.join(bundledDir, COMPOSITION_FILE)),
    metadataMatches: bundledDir !== void 0 && fs5.existsSync(path8.join(dir, METADATA_FILE)) && sameBytes(path8.join(dir, METADATA_FILE), path8.join(bundledDir, METADATA_FILE))
  };
}
function sameBytes(left, right) {
  try {
    return fs5.readFileSync(left).equals(fs5.readFileSync(right));
  } catch {
    return false;
  }
}

export {
  createPathGuard,
  deepMerge,
  loadPolicy,
  updateUserPolicy,
  ledgerFilePath,
  readLedger,
  appendEntry,
  markDone,
  scanPending,
  pendingOlderThan,
  preferenceFilePath,
  recordDelivery,
  loadInterests,
  loadWatchlist,
  checkWatchlist,
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
  renderTemplateReport,
  BUNDLED_PRESET_ID,
  userPresetRoot,
  conventionalUserPresetRoot,
  installBundledPreset,
  describeInstall,
  presetStatus
};
//# sourceMappingURL=chunk-2SYXKKZF.js.map