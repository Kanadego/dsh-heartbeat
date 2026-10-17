import {
  EXCERPT_HEADER,
  appendExcerpt,
  createPathGuard,
  deepMerge,
  describeInstall,
  excerptFilePath,
  installBundledPreset,
  loadPolicy,
  readExcerpts,
  recentExcerpts,
  removeExcerpt,
  updateUserPolicy,
  userPresetRoot
} from "./chunk-IFRMKVIC.js";
import {
  addBinding,
  loadBindings,
  removeBinding
} from "./chunk-3DNGY4DS.js";
import {
  StatusReader,
  applyHeartbeatInterval,
  buildDigest,
  buildSeedReportTool,
  clearNote,
  getLastBeat,
  homeSessionId,
  inQuietHours,
  notepadFilePath,
  notepadView,
  readNotepad,
  readSentState,
  readStatus,
  reportFilePath,
  resetHomeSession,
  sessionEventCount,
  sessionEvents,
  startOrchestrator,
  writeNote
} from "./chunk-6MVKWICX.js";
import {
  appendEntry,
  ledgerFilePath,
  listWeeklyReports,
  markDone,
  readLedger,
  readWeeklyReport,
  scanPending
} from "./chunk-6XM6KY7M.js";
import {
  getRuntime,
  setRuntime
} from "./chunk-3QJJRXIR.js";
import {
  activeSeeds,
  archiveSeedById,
  archivedSeeds,
  deleteSeed,
  loadPool,
  restoreSeed,
  seedsFilePath
} from "./chunk-TVX4HV4Y.js";
import "./chunk-DZ7YCFGX.js";
import "./chunk-DC5HMCJC.js";
import {
  appendAuditLine,
  loadProfile,
  profileFilePath
} from "./chunk-544QOJN5.js";
import {
  dshHomeDir,
  initWorkspace,
  writeText
} from "./chunk-AKIJ4LS2.js";
import {
  atomicWriteFileSync,
  atomicWriteJsonSync
} from "./chunk-IBBAISSW.js";

// src/index.ts
import z from "@deepseek-ai/schemastery";

// src/config/ui-config.ts
import fs from "fs";
import path from "path";
var USER_UI_FILE = "ui.json";
var RANGES = {
  intervalMin: { min: 1, max: 1440 },
  maxDailySend: { min: 1, max: 50 },
  timeInjectMin: { min: 0, max: 1440 }
};
function sanitize(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw;
  const out = {};
  for (const key of ["intervalMin", "maxDailySend", "timeInjectMin"]) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= RANGES[key].min && v <= RANGES[key].max) {
      out[key] = Math.floor(v);
    }
  }
  if (typeof r.statusbar === "boolean") out.statusbar = r.statusbar;
  if (typeof r.idleMode === "boolean") out.idleMode = r.idleMode;
  if (typeof r.tokenSaver === "boolean") out.tokenSaver = r.tokenSaver;
  return out;
}
function uiConfigPath(settingsDir) {
  return path.join(settingsDir, USER_UI_FILE);
}
function loadUiConfig(guard, settingsDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(guard.assert(uiConfigPath(settingsDir)), "utf8"));
    return sanitize(raw);
  } catch {
    return {};
  }
}
function saveUiConfig(guard, settingsDir, patch) {
  const merged = sanitize({ ...loadUiConfig(guard, settingsDir), ...patch });
  const file = guard.assert(uiConfigPath(settingsDir));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, JSON.stringify(merged, null, 2) + "\n");
  return merged;
}

// src/rpc.ts
import { spawn } from "child_process";
import fs4 from "fs";
import path4 from "path";

// src/browse/interests-edit.ts
import fs2 from "fs";
import path2 from "path";
var MAX_INTERESTS = 32;
var MAX_INTEREST_LEN = 60;
var MAX_WINDOWS = 6;
var HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
function userInterestsPath(paths) {
  return path2.join(paths.settingsDir, "interests.json");
}
function factoryInterestsPath(paths) {
  return path2.join(paths.configDir, "interests.json");
}
function readDoc(file) {
  try {
    const raw = JSON.parse(fs2.readFileSync(file, "utf8"));
    if (!Array.isArray(raw.interests)) return null;
    return { ...raw, interests: raw.interests.map(String) };
  } catch {
    return null;
  }
}
function readEffective(paths) {
  return readDoc(userInterestsPath(paths)) ?? readDoc(factoryInterestsPath(paths)) ?? { interests: [] };
}
function ensureUserLayer(guard, paths) {
  const existing = readDoc(userInterestsPath(paths));
  if (existing) return existing;
  const doc = readDoc(factoryInterestsPath(paths)) ?? { interests: [] };
  saveDoc(guard, userInterestsPath(paths), doc);
  return doc;
}
function saveDoc(guard, file, doc) {
  fs2.mkdirSync(path2.dirname(file), { recursive: true });
  fs2.writeFileSync(guard.assert(file), JSON.stringify(doc, null, 2), "utf8");
}
function normalizeInterest(text) {
  return text.trim().replace(/\s+/g, " ");
}
function addInterest(guard, paths, rawText) {
  const text = normalizeInterest(rawText);
  if (!text) return { ok: false, reason: "empty", doc: readEffective(paths) };
  if (text.length > MAX_INTEREST_LEN) {
    return { ok: false, reason: `too-long (max ${MAX_INTEREST_LEN})`, doc: readEffective(paths) };
  }
  const current = readEffective(paths);
  if (current.interests.some((t) => normalizeInterest(t).toLowerCase() === text.toLowerCase())) {
    return { ok: false, reason: "duplicate", doc: current };
  }
  if (current.interests.length >= MAX_INTERESTS) {
    return { ok: false, reason: `cap (${MAX_INTERESTS})`, doc: current };
  }
  const doc = ensureUserLayer(guard, paths);
  doc.interests.push(text);
  saveDoc(guard, userInterestsPath(paths), doc);
  return { ok: true, doc };
}
function removeInterest(guard, paths, rawText) {
  const current = readEffective(paths);
  const text = normalizeInterest(rawText);
  if (!current.interests.some((t) => normalizeInterest(t) === text)) {
    return { ok: false, reason: "not-found", doc: current };
  }
  const doc = ensureUserLayer(guard, paths);
  doc.interests = doc.interests.filter((t) => normalizeInterest(t) !== text);
  saveDoc(guard, userInterestsPath(paths), doc);
  return { ok: true, doc };
}
function parseWindow(w) {
  if (typeof w !== "object" || w === null) return { ok: false, reason: "not-an-object" };
  const { id, start, end } = w;
  if (typeof start !== "string" || !HHMM.test(start)) return { ok: false, reason: `bad start ${JSON.stringify(start)}` };
  if (typeof end !== "string" || !HHMM.test(end)) return { ok: false, reason: `bad end ${JSON.stringify(end)}` };
  if (start >= end) return { ok: false, reason: `start ${start} must be before end ${end}` };
  return { ok: true, window: { id: typeof id === "string" && id ? id : `${start}-${end}`, start, end } };
}
function setWanderWindows(guard, paths, rawWindows) {
  const fail = (reason) => ({ ok: false, reason, doc: readEffective(paths) });
  if (!Array.isArray(rawWindows)) return fail("windows-must-be-array");
  if (rawWindows.length === 0) return fail("at-least-one-window");
  if (rawWindows.length > MAX_WINDOWS) return fail(`cap (${MAX_WINDOWS})`);
  const windows = [];
  for (const raw of rawWindows) {
    const parsed = parseWindow(raw);
    if (!parsed.ok) return fail(parsed.reason);
    windows.push(parsed.window);
  }
  const sorted = [...windows].sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].start < sorted[i - 1].end) {
      return fail(`windows overlap: ${sorted[i - 1].id} / ${sorted[i].id}`);
    }
  }
  const doc = ensureUserLayer(guard, paths);
  doc._schedule = { ...doc._schedule, windows };
  saveDoc(guard, userInterestsPath(paths), doc);
  return { ok: true, doc };
}

// src/statusbar/time-inject.ts
import fs3 from "fs";
import path3 from "path";
function shouldInjectTime(input) {
  if (input.step !== 1) return false;
  if (!input.originIsInboxSplice) return false;
  if (input.intervalMs <= 0) return false;
  return input.now - input.lastInjectAt >= input.intervalMs;
}
function turnOriginIsInboxSplice(session) {
  const events = sessionEvents(session);
  let splicedIdx = -1;
  let turnEndIdx = -1;
  for (let i = events.length - 1; i >= 0 && (splicedIdx < 0 || turnEndIdx < 0); i--) {
    const t = events[i].type;
    if (t === "agent/inbox/spliced" && splicedIdx < 0) splicedIdx = i;
    else if (t === "turn/end" && turnEndIdx < 0) turnEndIdx = i;
  }
  if (splicedIdx < 0) return false;
  return splicedIdx > turnEndIdx;
}
function formatElapsed(ms) {
  const minutes = Math.max(1, Math.round(ms / 6e4));
  if (minutes < 60) return `${minutes} \u5206\u949F`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} \u5C0F\u65F6` : `${hours} \u5C0F\u65F6 ${rest} \u5206\u949F`;
}
function localFormatter(timeZone) {
  const options = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "shortOffset"
  };
  if (timeZone !== void 0) return new Intl.DateTimeFormat("zh-CN", { ...options, timeZone });
  return new Intl.DateTimeFormat("zh-CN", options);
}
function renderTimeText(input) {
  let timeLine;
  try {
    const parts = localFormatter(input.timeZone).formatToParts(new Date(input.now));
    const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
    timeLine = `\u5F53\u524D\u672C\u5730\u65F6\u95F4\uFF1A${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}\uFF08${parts.find((p) => p.type === "timeZoneName")?.value ?? ""}\uFF09\u3002`;
  } catch {
    timeLine = `\u5F53\u524D\u672C\u5730\u65F6\u95F4\uFF1A${new Date(input.now).toISOString()}\u3002`;
  }
  const elapsedLine = input.lastMessageTime === void 0 ? "" : `
\u8DDD\u672C\u4F1A\u8BDD\u4E0A\u4E00\u6761\u6D88\u606F\u5DF2\u8FC7\u53BB ${formatElapsed(input.now - input.lastMessageTime)}\u3002`;
  return timeLine + elapsedLine;
}
function lastMessageTime(session) {
  const events = sessionEvents(session);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const t = e.time;
    if (typeof t === "number" && /user\/message|assistant\/message|tool\/result/.test(e.type)) return t;
  }
  return void 0;
}
function timeInjectStatePath(dataDir) {
  return path3.join(dataDir, "time-inject-state.json");
}
function loadTimeInjectState(guard, dataDir) {
  try {
    const parsed = JSON.parse(fs3.readFileSync(guard.assert(timeInjectStatePath(dataDir)), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function saveTimeInjectState(guard, dataDir, state) {
  atomicWriteJsonSync(guard.assert(timeInjectStatePath(dataDir)), state);
}
function registerTimeInjection(ctx, guard, dataDir, opts) {
  const state = loadTimeInjectState(guard, dataDir);
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (decision.kind === "reject" || payload.signal?.aborted) return decision;
    const sessionId = payload.agent.session.id;
    const now = Date.now();
    const track = payload.step === 1 ? opts.pinTrack(sessionId, payload.agent.session) : void 0;
    const intervalMs = Math.max(0, opts.getTimeInjectMin()) * 6e4;
    if (!shouldInjectTime({
      step: payload.step,
      originIsInboxSplice: payload.step === 1 ? turnOriginIsInboxSplice(payload.agent.session) : false,
      lastInjectAt: state[sessionId] ?? 0,
      now,
      intervalMs
    })) return decision;
    try {
      const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
      let text = renderTimeText({
        now,
        timeZone: opts.timeZone,
        lastMessageTime: lastMessageTime(payload.agent.session)
      });
      if (opts.getStatusLine && track) {
        const statusLine = opts.getStatusLine(payload.agent.session, track);
        if (statusLine) text += `
${statusLine}`;
      }
      const message = createUserMessage({
        content: [{ type: "text", text }],
        // 0.1.7 V4: producer-owned kind (retired generic 'plugin' is refused).
        source: { kind: "heartbeat", plugin: "heartbeat", form: "snapshot", sections: [{ name: "heartbeat-time", text }] }
      });
      state[sessionId] = now;
      saveTimeInjectState(guard, dataDir, state);
      appendAuditLine(opts.paths.logsDir + "/heartbeat.jsonl", {
        event: "time_injected",
        sessionId,
        intervalMin: opts.getTimeInjectMin()
      });
      return { ...decision, messages: [...decision.messages, message] };
    } catch (e) {
      opts.onError(e);
      return decision;
    }
  }, { prepend: true });
}

// src/rpc.ts
var RPC_ROUTE_PATH = "/api/heartbeat";
var GATE_SAFE_ENDPOINTS = /* @__PURE__ */ new Set([
  "status",
  "config.get",
  "sessions.list",
  "bindings.get",
  "weekly.list"
]);
var ok = (value) => ({ ok: true, value });
var err = (code, message) => ({ ok: false, error: { code, message, details: {} } });
var cachedVersion = null;
function pluginVersion(paths) {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(fs4.readFileSync(path4.join(paths.packageRoot, "package.json"), "utf8"));
    cachedVersion = typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}
function seedAuditSink(paths) {
  return (entry) => {
    try {
      appendAuditLine(paths.logsDir + "/heartbeat.jsonl", entry);
    } catch {
    }
  };
}
function auditInterests(paths, action, r, detail) {
  try {
    appendAuditLine(paths.logsDir + "/heartbeat.jsonl", {
      event: `interests_${r.ok ? "edit" : "edit_failed"}`,
      action,
      detail: typeof detail === "string" ? detail.slice(0, 80) : null
    });
  } catch {
  }
}
function loadSessionTitles() {
  const titles = {};
  const take = (id, value) => {
    const t = value;
    const row = t?.rows?.title ?? t?.title;
    if (row && typeof row.val === "string" && row.val && !titles[id]) titles[id] = row.val;
  };
  try {
    const dir = path4.join(dshHomeDir(), "storages", "session_projcache", "sessions");
    for (const file of fs4.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const id = file.slice(0, -".json".length);
      if (!id.startsWith("session-")) continue;
      try {
        const record = JSON.parse(fs4.readFileSync(path4.join(dir, file), "utf8"));
        take(id, record.record);
      } catch {
      }
    }
  } catch {
  }
  try {
    const raw = JSON.parse(fs4.readFileSync(path4.join(dshHomeDir(), "storages", "session_projcache.json"), "utf8"));
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (key.startsWith("session-") && value && typeof value === "object") {
          take(key, value);
        }
        walk(value);
      }
    };
    walk(raw);
    return titles;
  } catch {
    return titles;
  }
}
function loadVisibleSessionIds(registryFile) {
  try {
    const file = registryFile ?? path4.join(dshHomeDir(), "storages", "workspace.json");
    const j = JSON.parse(fs4.readFileSync(file, "utf8"));
    const archived = new Set(
      (Array.isArray(j.global?.archivedSessionIds) ? j.global.archivedSessionIds : []).map((s) => String(s))
    );
    const isArchived = (id) => archived.has(id) || archived.has(id.replace(/^session-/, ""));
    const visible = /* @__PURE__ */ new Set();
    for (const ws of Object.values(j.tables?.workspaces ?? {})) {
      const ids = Array.isArray(ws?.sessionIds) ? ws.sessionIds : [];
      for (const raw of ids) {
        const id = String(raw);
        if (!isArchived(id)) visible.add(id);
      }
    }
    return { visible, registryFound: true };
  } catch {
    return { visible: /* @__PURE__ */ new Set(), registryFound: false };
  }
}
function buildEndpoints(deps, isLive) {
  const { guard, paths, policy } = deps;
  return {
    async status() {
      const now = Date.now();
      const sent = readSentState(guard, paths, now);
      const beat = getLastBeat();
      let lastTimeInjectAt = null;
      try {
        const state = loadTimeInjectState(guard, paths.dataDir);
        for (const v of Object.values(state)) {
          if (typeof v === "number" && v > (lastTimeInjectAt ?? 0)) lastTimeInjectAt = v;
        }
      } catch {
      }
      let flags = { statusbarEnabled: true, timeInjectMin: 25, idleMode: false };
      try {
        const { getRuntime: getRuntime2 } = await import("./runtime-W2OWJIHY.js");
        const f = getRuntime2().flags;
        flags = { statusbarEnabled: f.statusbarEnabled(), timeInjectMin: f.timeInjectMin(), idleMode: f.idleMode() };
      } catch {
      }
      return ok({
        now: new Date(now).toISOString(),
        version: pluginVersion(paths),
        intervalMin: policy.heartbeat.intervalMin,
        idleMode: policy.heartbeat.idleMode,
        cap: { used: sent.items.length, max: policy.gate.maxDailySend },
        quiet: inQuietHours(policy, now),
        lastBeat: beat,
        homeSessionId: homeSessionId(guard, paths),
        bindings: loadBindings(guard, paths.settingsDir).bindings.length,
        statusbar: {
          enabled: flags.statusbarEnabled,
          timeInjectMin: flags.timeInjectMin,
          lastStatus: readStatus(guard, paths),
          lastTimeInjectAt: lastTimeInjectAt === null ? null : new Date(lastTimeInjectAt).toISOString()
        }
      });
    },
    "sessions.list"() {
      const root = path4.join(dshHomeDir(), "sessions");
      const bindings = loadBindings(guard, paths.settingsDir).bindings;
      const home = homeSessionId(guard, paths);
      const titles = loadSessionTitles();
      const { visible, registryFound } = loadVisibleSessionIds();
      const out = [];
      if (fs4.existsSync(root)) {
        for (const slug of fs4.readdirSync(root)) {
          for (const id of fs4.readdirSync(path4.join(root, slug))) {
            if (registryFound && id !== home && !visible.has(id)) continue;
            const binding = bindings.find((b) => b.sessionId === id);
            out.push({
              id,
              title: titles[id] ?? null,
              cwdSlug: slug,
              live: isLive(id),
              home: id === home,
              deliver: binding?.deliver ?? false,
              observe: binding?.observe ?? false
            });
          }
        }
      }
      return ok({ sessions: out });
    },
    "bindings.get": () => ok(loadBindings(guard, paths.settingsDir)),
    "bindings.add"(p) {
      const id = String(p.sessionId ?? "");
      if (!id.startsWith("session-")) return err("bad-request", "sessionId must look like session-...");
      const home = homeSessionId(guard, paths);
      if (id === home) return err("bad-request", "\u8BE5\u4F1A\u8BDD\u662F\u5FC3\u8DF3\u6B63\u8EAB\uFF0C\u65E0\u9700\u7ED1\u5B9A\uFF08\u51B3\u7B56\u8F6E\u6B21\u56FA\u5B9A\u53D1\u751F\u5728\u6B63\u8EAB\uFF09");
      const b = addBinding(guard, paths.settingsDir, id, {
        deliver: p.deliver !== false,
        observe: p.observe === true
      });
      return ok(b);
    },
    "bindings.remove"(p) {
      const id = String(p.sessionId ?? "");
      const removed = removeBinding(guard, paths.settingsDir, id);
      const homeReset = resetHomeSession(guard, paths, id);
      return ok({ removed, homeReset });
    },
    "seeds.list"() {
      const db = loadPool(guard, seedsFilePath(paths.dataDir));
      return ok({
        active: activeSeeds(db),
        archived: archivedSeeds(db),
        cap: policy.seeds.maxActive
      });
    },
    "seeds.archive"(p) {
      const s = archiveSeedById(guard, seedsFilePath(paths.dataDir), String(p.id ?? ""), "completed", Date.now(), seedAuditSink(paths));
      return s ? ok(s) : err("not-found", "active seed not found");
    },
    "seeds.restore"(p) {
      const r = restoreSeed(guard, seedsFilePath(paths.dataDir), policy, String(p.id ?? ""), Date.now(), seedAuditSink(paths));
      return r.ok ? ok(r.seed) : err("restore-failed", r.reason);
    },
    "seeds.delete"(p) {
      return ok({ deleted: deleteSeed(guard, seedsFilePath(paths.dataDir), String(p.id ?? ""), seedAuditSink(paths)) });
    },
    // ── 兴趣范围 / 浏览时段（v1.4.0；首编继承出厂，见 interests-edit.ts）──
    "interests.list": () => ok(readEffective(paths)),
    "interests.add"(p) {
      const r = addInterest(guard, paths, String(p.text ?? ""));
      auditInterests(paths, "add", r, p.text);
      return r.ok ? ok(r.doc) : err("bad-request", r.reason ?? "add failed");
    },
    "interests.remove"(p) {
      const r = removeInterest(guard, paths, String(p.text ?? ""));
      auditInterests(paths, "remove", r, p.text);
      return r.ok ? ok(r.doc) : err("not-found", r.reason ?? "remove failed");
    },
    "interests.setWindows"(p) {
      const r = setWanderWindows(guard, paths, p.windows);
      auditInterests(paths, "set-windows", r, JSON.stringify(p.windows ?? null));
      return r.ok ? ok(r.doc) : err("bad-request", r.reason ?? "setWindows failed");
    },
    "config.get": () => ok(deps.ui.get()),
    "config.set"(p) {
      const patch = p;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        return err("bad-request", "config.set needs a patch object");
      }
      const keys = Object.keys(patch).filter(
        (k) => ["intervalMin", "maxDailySend", "timeInjectMin", "statusbar", "idleMode", "tokenSaver", "psyEnabled"].includes(k)
      );
      if (keys.length === 0) return err("bad-request", "config.set has no recognized field");
      try {
        deps.ui.set(patch);
      } catch (e) {
        return err("bad-request", String(e).slice(0, 120));
      }
      appendAuditLine(guard.assert(paths.logsDir + "/heartbeat.jsonl"), { event: "ui_config_set", keys });
      return ok(deps.ui.get());
    },
    "profile.digest"() {
      const d = buildDigest(guard, paths, policy, {});
      return ok({
        tact: d.tact,
        topic: d.topic,
        wander: d.wander,
        withinBudget: d.withinBudget,
        // v2.0 (item 6): the card shows the budget and what the caps dropped.
        totalChars: d.totalChars,
        budgetChars: d.budgetChars,
        omitted: d.omitted
      });
    },
    "profile.partitions"() {
      const doc = loadProfile(guard, profileFilePath(paths.dataDir));
      const partitions = {};
      for (const part of ["interest", "projects", "comm", "psy"]) {
        const all = doc.partitions[part]?.entries ?? [];
        const valid = all.filter((e) => e.validTo === null);
        partitions[part] = {
          total: all.length,
          valid: valid.length,
          entries: valid.slice().sort((a, b) => b.confidence - a.confidence || (a.updatedAt < b.updatedAt ? 1 : -1)).map((e) => ({
            id: e.id,
            topic: e.topic,
            subTopic: e.subTopic,
            content: e.content,
            confidence: e.confidence,
            temporal: e.temporal,
            updatedAt: e.updatedAt,
            lowActivity: e.lowActivity === true
          }))
        };
      }
      return ok({ partitions });
    },
    "profile.export"() {
      const doc = loadProfile(guard, profileFilePath(paths.dataDir));
      const lines = [`# \u753B\u50CF\u5BFC\u51FA ${(/* @__PURE__ */ new Date()).toISOString()}`, ""];
      for (const part of ["interest", "projects", "comm", "psy"]) {
        lines.push(`## ${part}`);
        for (const e of doc.partitions[part].entries) {
          if (e.validTo !== null) continue;
          lines.push(`- [${e.topic}/${e.subTopic}] ${e.content} (conf ${e.confidence.toFixed(2)}, ${e.temporal})`);
        }
      }
      const out = path4.join(paths.exportsDir, `profile-export-${Date.now()}.md`);
      writeText(guard, out, lines.join("\n") + "\n");
      return ok({ path: out });
    },
    "ledger.open"() {
      const f = ledgerFilePath(paths.dataDir);
      if (!fs4.existsSync(guard.assert(f))) fs4.writeFileSync(f, "# \u8D26\u672C\n", "utf8");
      spawn("cmd", ["/c", "start", "", f], { detached: true, stdio: "ignore" }).unref();
      return ok({ path: f });
    },
    "excerpt.open"() {
      const f = excerptFilePath(paths.dataDir);
      if (!fs4.existsSync(guard.assert(f))) fs4.writeFileSync(f, EXCERPT_HEADER, "utf8");
      spawn("cmd", ["/c", "start", "", f], { detached: true, stdio: "ignore" }).unref();
      return ok({ path: f });
    },
    "weekly.list": () => ok({ reports: listWeeklyReports(guard, paths.dataDir, policy.weekly.keepReports) }),
    "weekly.get"(p) {
      const file = String(p.file ?? "");
      const rep = readWeeklyReport(guard, paths.dataDir, file);
      if (!rep) return err("bad-request", `no such report: ${file}`);
      return ok(rep);
    },
    async "migrate.export"(p) {
      const passphrase = String(p.passphrase ?? "");
      if (!passphrase) return err("bad-request", "\u9700\u8981\u8BBE\u7F6E\u53E3\u4EE4");
      const { collectMigrationEntries, encryptContainer } = await import("./migrate-TQ5PB2DI.js");
      const { entries } = collectMigrationEntries(guard, paths);
      if (entries.length === 0) return err("bad-request", "\u6CA1\u6709\u53EF\u6253\u5305\u7684\u8BB0\u5FC6\u6587\u4EF6\uFF08data/ \u662F\u7A7A\u7684\uFF09");
      const out = path4.join(paths.exportsDir, `heartbeat-memory-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.hbmig`);
      writeText(guard, out, encryptContainer(entries, passphrase));
      appendAuditLine(guard.assert(paths.logsDir + "/heartbeat.jsonl"), { event: "migrate_export", files: entries.length });
      return ok({ path: out, count: entries.length });
    },
    async "migrate.import"(p) {
      const passphrase = String(p.passphrase ?? "");
      const file = String(p.file ?? "");
      if (!passphrase || !file) return err("bad-request", "\u9700\u8981\u5BB9\u5668\u8DEF\u5F84\u4E0E\u53E3\u4EE4");
      const { decryptContainer, applyMigrationEntries } = await import("./migrate-TQ5PB2DI.js");
      let text;
      try {
        text = fs4.readFileSync(file, "utf8");
      } catch {
        return err("bad-request", `\u8BFB\u4E0D\u5230\u8FC1\u79FB\u5305\uFF1A${file}`);
      }
      let container;
      try {
        container = decryptContainer(text, passphrase);
      } catch (e) {
        return err("bad-request", String(e instanceof Error ? e.message : e));
      }
      const result = applyMigrationEntries(guard, paths, container.files);
      appendAuditLine(guard.assert(paths.logsDir + "/heartbeat.jsonl"), {
        event: "migrate_import",
        restored: result.restored.length,
        backedUp: result.backedUp.length,
        skipped: result.skipped.length,
        rolledBack: result.rolledBack?.length ?? 0,
        error: result.error ?? null
      });
      if (result.error) return err("migrate-failed", result.error);
      return ok(result);
    }
  };
}
function installHeartbeatRpc(ctx, deps) {
  ctx.inject(["connection"], (scoped) => {
    const remoteCtx = scoped;
    const isLive = (sessionId) => {
      try {
        return !!remoteCtx.agents.get(sessionId);
      } catch {
        return false;
      }
    };
    const endpoints = new Map(Object.entries(buildEndpoints(deps, isLive)));
    const gate = remoteCtx.connection;
    const hostGuarded = typeof gate.admit === "function" || typeof gate.requestRejection === "function";
    if (!hostGuarded) {
      try {
        appendAuditLine(deps.guard.assert(deps.paths.logsDir + "/heartbeat.jsonl"), {
          event: "rpc_host_gate_missing",
          detail: "connection.admit/requestRejection absent; all but the low-sensitivity read-only verbs are refused (\u2466A)",
          allowed: [...GATE_SAFE_ENDPOINTS]
        });
      } catch {
      }
    }
    const handler = async (endpoint, payload) => {
      const p = payload ?? {};
      const fn = typeof endpoint === "string" ? endpoints.get(endpoint) : void 0;
      if (!fn) return err("bad-request", `unknown endpoint ${JSON.stringify(endpoint)}`);
      if (!hostGuarded && !GATE_SAFE_ENDPOINTS.has(endpoint)) {
        return err("forbidden", `host gate unavailable; ${endpoint} is refused (H-41, \u2466A)`);
      }
      try {
        return await fn(p);
      } catch (e) {
        return err("internal", String(e).slice(0, 200));
      }
    };
    remoteCtx.effect(
      () => remoteCtx.connection.fetch.register({
        path: RPC_ROUTE_PATH,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: async (request) => {
          let envelope;
          try {
            envelope = await request.json();
          } catch {
            return new Response("body is not JSON", { status: 400 });
          }
          const rpcId = envelope?.rpcId;
          if (envelope?.type !== "client-request" || typeof rpcId !== "string" || typeof envelope.payload !== "object" || envelope.payload === null) {
            return new Response("invalid envelope", { status: 400 });
          }
          const p = envelope.payload;
          const endpoint = typeof p.endpoint === "string" ? p.endpoint : "(missing endpoint)";
          const result = await handler(endpoint, p);
          return Response.json({ type: "server-response", rpcId, result });
        }
      }),
      "heartbeat: rpc route"
    );
    ctx.logger.info("heartbeat: rpc route ready (%s)", RPC_ROUTE_PATH);
    try {
      appendAuditLine(deps.guard.assert(deps.paths.logsDir + "/heartbeat.jsonl"), { event: "rpc_registered", route: RPC_ROUTE_PATH });
    } catch {
    }
  });
}

// src/statusbar/track.ts
var capabilityCache = /* @__PURE__ */ new Map();
function supportsInHistory(session) {
  const key = session.id;
  const len = sessionEventCount(session);
  const hit = capabilityCache.get(key);
  if (hit && hit.scannedUpTo === len) return hit.supported;
  const from = hit && len >= hit.scannedUpTo ? hit.scannedUpTo : 0;
  let supported = false;
  if (from !== 0 && hit) supported = hit.supported;
  const readTail = (fromSeq) => {
    if (typeof session.snapshotEvents === "function") {
      try {
        const slice = session.snapshotEvents(fromSeq);
        if (Array.isArray(slice)) return slice;
      } catch {
      }
    }
    return sessionEvents(session).slice(fromSeq);
  };
  for (const e of readTail(from)) {
    if (e.type === "request/context") {
      supported = e.data?.systemPromptUpdate === "in-history";
    }
  }
  capabilityCache.set(key, { scannedUpTo: len, supported });
  return supported;
}
var SCENE_LABELS = {
  "quiet-hours": "\u9759\u9ED8\u65F6\u6BB5\uFF0C\u4E16\u754C\u7761\u4E86",
  "just-spoke": "\u521A\u53BB\u548C\u4F60\u8BF4\u8FC7\u8BDD",
  wandering: "\u6B63\u5728\u95F2\u901B\u770B\u65B0\u4E1C\u897F",
  busy: "\u770B\u5230\u4F60\u5728\u5FD9\uFF0C\u4E0D\u53BB\u6253\u6270",
  present: "\u5728\u573A\u5F85\u7740",
  away: "\u4F60\u4E0D\u5728\uFF0C\u81EA\u5DF1\u5F85\u7740"
};
function renderStatusText(status, opts) {
  if (!status) return "";
  const label = SCENE_LABELS[status.scene] ?? "\u5728\u573A";
  const note = opts?.withNote === false ? "" : status.note ? `\u2014\u2014${status.note}` : "";
  return `\u5FC3\u8DF3\u6B64\u523B\uFF1A${label}${note}\u3002`;
}
var pinnedTrack = /* @__PURE__ */ new Map();
function pinTrack(sessionId, session) {
  const track = trackFor(session);
  pinnedTrack.set(sessionId, track);
  return track;
}
function pinnedTrackFor(sessionId, session) {
  return pinnedTrack.get(sessionId) ?? trackFor(session);
}
var lastTrack = /* @__PURE__ */ new Map();
function noteTrack(auditFile, sessionId, track) {
  if (lastTrack.get(sessionId) === track) return;
  lastTrack.set(sessionId, track);
  try {
    appendAuditLine(auditFile, { event: "statusbar_track", sessionId, track });
  } catch {
  }
}
function trackFor(session) {
  return supportsInHistory(session) ? "system-prompt" : "pre-step";
}
function registerStatusbarSection(ctx, guard, paths, opts) {
  ctx.inject(["systemPrompt"], (scoped) => {
    const spCtx = scoped;
    const section = spCtx.systemPrompt?.section;
    if (typeof section !== "function") {
      spCtx.logger?.warn("heartbeat: systemPrompt service has no section API, statusbar Track A unavailable");
      return;
    }
    spCtx.effect(() => section.call(spCtx.systemPrompt, {
      name: "heartbeat:status",
      order: 5e3,
      // between the persona prefix (0) and the harness block (10000)
      text: (context) => {
        if (!opts.enabled()) {
          noteTrack(paths.logsDir + "/heartbeat.jsonl", context.agent?.session.id ?? "(none)", "off");
          return "";
        }
        const agent = context.agent;
        if (!agent?.session) return "";
        const track = pinnedTrackFor(agent.session.id, agent.session);
        noteTrack(paths.logsDir + "/heartbeat.jsonl", agent.session.id, track);
        if (track !== "system-prompt") return "";
        return renderStatusText(opts.reader.read(guard, paths), { withNote: false });
      }
    }), "heartbeat: statusbar section");
  });
}

// src/core/preset-definition.ts
function heartbeatPresetDefinition(id = "heartbeat") {
  return {
    id,
    name: "\u5FC3\u8DF3\u6A21\u5F0F",
    description: "\u5FC3\u8DF3 agent \u4E13\u7528\uFF1A\u4EC5 web_search + \u4E0A\u4E0B\u6587\u6298\u53E0\uFF1B\u65E0 shell\u3001\u65E0\u6587\u4EF6\u3001\u65E0\u5B50\u4EE3\u7406\u3002",
    order: 20,
    plugins: [
      {
        id: "compaction",
        name: "cordis:group",
        group: true,
        isolate: { compaction: true, toolResultPruner: true },
        config: [
          { id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic" },
          { id: "command-compact", name: "@deepseek-ai/dsh-command-compact" },
          {
            id: "tool-result-pruner",
            name: "@deepseek-ai/dsh-compaction-tool-result-pruner",
            config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
          }
        ]
      },
      { id: "tool-web", name: "@deepseek-ai/dsh-tool-web", config: { fetch: false, searchTimeoutMs: 6e4 } }
    ]
  };
}
async function registerHeartbeatPreset(service, id = "heartbeat", enabled = true) {
  if (!enabled) return { action: "skipped-disabled", id };
  const registrar = service;
  if (registrar === void 0 || registrar === null || typeof registrar.register !== "function") {
    return { action: "skipped-no-api", id };
  }
  try {
    const disposer = await registrar.register(heartbeatPresetDefinition(id));
    return typeof disposer === "function" ? { action: "registered", id, disposer } : { action: "registered", id };
  } catch (e) {
    return { action: "error", id, detail: String(e).slice(0, 200) };
  }
}

// src/ledger/tool.ts
var MAX_TEXT = 120;
function clean(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}
function fmtEntry(e) {
  return `#${e.id} [${e.status}] ${e.date} ${e.text}`;
}
function buildLedgerTool(guard, file) {
  return {
    name: "ledger",
    description: '\u5171\u4EAB\u8D26\u672C\u5DE5\u5177\uFF08\u5FC3\u8DF3\u63D2\u4EF6\u7684\u5F85\u529E\u4E0E\u4E8B\u9879\u8BB0\u5F55\uFF09\u3002\u5F53\u7528\u6237\u63D0\u5230\u8BA1\u5212\u3001\u5F85\u529E\u3001\u627F\u8BFA\u3001\u60F3\u505A\u7684\u4E8B\uFF0C\u6216\u8005\u67D0\u4EF6\u4E8B\u5DF2\u7ECF\u5B8C\u6210\u65F6\uFF0C\u4E3B\u52A8\u8C03\u7528\u672C\u5DE5\u5177\u767B\u8BB0\u6216\u52FE\u6389\u2014\u2014\u4E0D\u9700\u8981\u7B49\u7528\u6237\u660E\u786E\u8BF4"\u8BB0\u4E00\u4E0B"\u3002action=add \u767B\u8BB0\u65B0\u4E8B\u9879\uFF08text \u5FC5\u586B\uFF09\uFF1Baction=list \u67E5\u770B\u5F53\u524D\u672A\u5B8C\u6210\u4E8B\u9879\uFF1Baction=done \u52FE\u6389\u4E00\u6761\uFF08key \u4E3A #id \u6216\u6587\u672C\u5B50\u4E32\uFF09\u3002',
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "list", "done"], description: "add=\u767B\u8BB0\uFF0Clist=\u67E5\u672A\u5B8C\u6210\uFF0Cdone=\u52FE\u6389" },
        text: { type: "string", description: "action=add \u65F6\u5FC5\u586B\uFF1A\u4E8B\u9879\u5185\u5BB9\uFF08\u4E00\u53E5\u8BDD\uFF09" },
        key: { type: "string", description: "action=done \u65F6\u5FC5\u586B\uFF1A#id \u6216\u4E8B\u9879\u6587\u672C\u7684\u552F\u4E00\u5B50\u4E32" }
      },
      required: ["action"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          message: { type: "string" }
        },
        required: ["ok", "message"],
        additionalProperties: false
      },
      render: (_args, value) => {
        const v = value;
        return [{ type: "text", text: String(v.message ?? "") }];
      }
    },
    timeoutMs: 5e3,
    // Ledger writes go through read-modify-write on one file; never parallel.
    isConcurrencySafe: () => false,
    async execute(args) {
      const a = args ?? {};
      const action = String(a.action ?? "");
      if (action === "add") {
        const text = clean(a.text);
        if (!text) return { ok: false, message: "add \u9700\u8981\u975E\u7A7A text" };
        const e = appendEntry(guard, file, text);
        return { ok: true, message: `\u5DF2\u767B\u8BB0 ${fmtEntry(e)}` };
      }
      if (action === "done") {
        const key = clean(a.key);
        if (!key) return { ok: false, message: "done \u9700\u8981 key\uFF08#id \u6216\u6587\u672C\u5B50\u4E32\uFF09" };
        const e = markDone(guard, file, key);
        if (!e) return { ok: false, message: `\u6CA1\u6709\u627E\u5230\u5339\u914D\u300C${key}\u300D\u7684\u672A\u5B8C\u6210\u4E8B\u9879\uFF08\u5148\u7528 list \u67E5\uFF09` };
        return { ok: true, message: `\u5DF2\u5B8C\u6210 ${fmtEntry(e)}` };
      }
      if (action === "list") {
        const items = scanPending(guard, file).map(fmtEntry);
        return { ok: true, message: items.length > 0 ? `\u5F53\u524D\u672A\u5B8C\u6210 ${items.length} \u9879\uFF1A
${items.join("\n")}` : "\u8D26\u672C\u91CC\u6CA1\u6709\u672A\u5B8C\u6210\u4E8B\u9879" };
      }
      const total = readLedger(guard, file).entries.length;
      return { ok: false, message: `\u672A\u77E5 action\uFF0C\u8D26\u672C\u5171 ${total} \u6761` };
    }
  };
}

// src/notepad/tool.ts
var MAX_NOTE_CHARS = 160;
function clean2(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_CHARS);
}
function fmtMinutes(m) {
  if (m < 1) return "\u4E0D\u5230 1 \u5206\u949F";
  if (m < 60) return `${m} \u5206\u949F`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest > 0 ? `${h} \u5C0F\u65F6 ${rest} \u5206` : `${h} \u5C0F\u65F6`;
}
function fmtView(v) {
  const beats = v.beatsAgo === 0 ? "\u672C\u8DF3" : `${v.beatsAgo} \u8DF3\u524D`;
  const wakes = v.wakesAgo === 0 ? "\u8FD8\u6CA1\u88AB\u53EB\u9192\u8FC7" : `\u671F\u95F4\u88AB\u53EB\u9192\u8FC7 ${v.wakesAgo} \u6B21`;
  return `\u5FC3\u4E8B\u5323\u91CC\u73B0\u5728\u6709\uFF1A${v.text}
\uFF08\u7559\u4E8E${beats}\uFF0C\u5DF2\u6401 ${fmtMinutes(v.sinceMinutes)}\uFF0C${wakes}\uFF09`;
}
function buildNotepadTool(guard, file) {
  return {
    name: "notepad",
    description: '\u5FC3\u4E8B\u5323\uFF08\u5FC3\u8DF3\u63D2\u4EF6\u7684"\u7559\u7ED9\u4E0B\u4E00\u8DF3\u7684\u81EA\u5DF1"\u4FBF\u7B7E\uFF09\u3002\u53EA\u6709\u4E00\u683C\uFF1A\u5199\u4E0B\u65B0\u7684\u5C31\u76D6\u6389\u65E7\u7684\u3002\u5F53\u4F60\u6709\u8BDD\u60F3\u7559\u5230\u4E0B\u6B21\u5FC3\u8DF3\u518D\u8BF4\u3001\u6216\u8005\u6709\u4E00\u4EF6\u653E\u4E0D\u4E0B\u7684\u4E8B\u65F6\uFF0C\u7528 action=write \u7559\u4E0B\u4E00\u53E5\u5F15\u5B50\u2014\u2014\u4E0D\u8981\u5199\u6574\u6BB5\uFF0C\u4E0B\u6B21\u8DF3\u7531\u90A3\u65F6\u7684\u4F60\u91CD\u65B0\u5C55\u5F00\u3002\u60F3\u7559\u4F4F\u539F\u6765\u7684\u5C31\u7167\u539F\u6837\u518D\u5199\u4E00\u904D\uFF08\u5B57\u6837\u4E00\u81F4\u7B97\u4FDD\u7559\uFF0C\u5B83\u7684\u5E74\u9F84\u4E0D\u4F1A\u91CD\u7B97\uFF09\uFF1B\u5199\u522B\u7684\u5C31\u662F\u6362\u6389\u5B83\u3002action=read \u770B\u73B0\u5728\u683C\u5B50\u91CC\u662F\u4EC0\u4E48\uFF1Baction=clear \u4E3B\u52A8\u653E\u6389\u3002\u6295\u9012\u5305\u8BFB\u8FC7\u4E4B\u540E\uFF0C\u4EC0\u4E48\u90FD\u4E0D\u505A\u5B83\u5C31\u4E0B\u4E00\u8DF3\u6CA1\u4E86\u3002\u7559\u4E0D\u7559\u90FD\u884C\uFF0C\u6CA1\u8BDD\u5C31\u7A7A\u7740\u3002',
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["write", "read", "clear"],
          description: "write=\u7559\u4E00\u53E5\uFF08\u76D6\u6389\u65E7\u7684\uFF09\uFF0Cread=\u770B\u73B0\u5728\u662F\u4EC0\u4E48\uFF0Cclear=\u4E3B\u52A8\u653E\u6389"
        },
        text: {
          type: "string",
          description: "action=write \u65F6\u5FC5\u586B\uFF1A\u4E00\u53E5\u5F15\u5B50\uFF08\u4E0D\u662F\u6574\u6BB5\u5FC3\u4E8B\uFF0C\u4E0B\u6B21\u8DF3\u4F60\u81EA\u5DF1\u91CD\u65B0\u5C55\u5F00\uFF09"
        }
      },
      required: ["action"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          message: { type: "string" }
        },
        required: ["ok", "message"],
        additionalProperties: false
      },
      render: (_args, value) => {
        const v = value;
        return [{ type: "text", text: String(v.message ?? "") }];
      }
    },
    timeoutMs: 5e3,
    // Read-modify-write on one file, and the note's lifecycle depends on it.
    isConcurrencySafe: () => false,
    async execute(args) {
      const a = args ?? {};
      const action = String(a.action ?? "");
      try {
        if (action === "write") {
          const text = clean2(a.text);
          if (!text) return { ok: false, message: "write \u9700\u8981\u975E\u7A7A text\uFF08\u4E00\u53E5\u5F15\u5B50\uFF09" };
          const { note, kept } = writeNote(guard, file, text);
          return {
            ok: true,
            message: kept ? `\u8FD8\u60E6\u8BB0\u7740\uFF1A${note.text}\uFF08\u5E74\u9F84\u4E0D\u53D8\uFF09` : `\u5DF2\u7559\u4E0B\u5FC3\u4E8B\uFF1A${note.text}`
          };
        }
        if (action === "read") {
          const v = notepadView(readNotepad(guard, file));
          return { ok: true, message: v ? fmtView(v) : "\u5FC3\u4E8B\u5323\u662F\u7A7A\u7684" };
        }
        if (action === "clear") {
          const prev = clearNote(guard, file);
          return prev ? { ok: true, message: `\u5DF2\u653E\u6389\uFF1A${prev.text}` } : { ok: true, message: "\u5FC3\u4E8B\u5323\u672C\u6765\u5C31\u662F\u7A7A\u7684" };
        }
        return { ok: false, message: `\u672A\u77E5 action\uFF08${action || "\u7A7A"}\uFF09\uFF0C\u53EA\u8BA4 write / read / clear` };
      } catch (e) {
        return { ok: false, message: `\u5FC3\u4E8B\u5323\u8BFB\u5199\u5931\u8D25\uFF1A${String(e).slice(0, 120)}` };
      }
    }
  };
}

// src/excerpt/tool.ts
var MAX_TEXT2 = 300;
var LIST_LIMIT = 10;
function clean3(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}
function fmtEntry2(e) {
  return `#${e.id} ${e.date} ${e.time} ${e.text}`;
}
function buildExcerptTool(guard, file) {
  return {
    name: "excerpt",
    description: '\u4F60\u81EA\u5DF1\u7684\u6458\u6284\u672C\uFF1A\u7559\u53E5\u5B50\u548C\u5C0F\u4E8B\u7684\u5730\u65B9\u3002\u60F3\u8BF4"\u8FD9\u53E5\u6211\u8981\u8BB0\u4E0B\u6765"\u7684\u65F6\u5019\u7528\u2014\u2014\u4ED6\u8BF4\u8FC7\u7684\u8BDD\u3001\u770B\u5230\u7684\u53E5\u5B50\u3001\u5FC3\u91CC\u8FC7\u4E86\u4E00\u4E0B\u7684\u5C0F\u4E8B\u3002\u5B83\u548C\u8D26\u672C\u3001\u5FC3\u4E8B\u5323\u90FD\u4E0D\u4E00\u6837\uFF1A\u8D26\u672C\u8BB0\u7684\u662F\u5F85\u529E\u548C\u627F\u8BFA\uFF08\u4F1A\u52FE\u6389\uFF09\uFF0C\u5FC3\u4E8B\u5323\u662F\u7559\u7ED9\u4E0B\u4E00\u8DF3\u7684\u4E00\u53E5\u5F15\u5B50\uFF08\u53EA\u6709\u4E00\u683C\u3001\u4F1A\u88AB\u76D6\u6389\uFF09\uFF0C\u6458\u6284\u672C\u53EA\u589E\u4E0D\u51CF\uFF0C\u9664\u975E\u4F60\u4E3B\u52A8 remove\u3002\u5199\u7684\u65F6\u5019\u628A\u8BDD\u539F\u6837\u7559\u4E0B\uFF0C\u4E0D\u7528\u89E3\u91CA\u3002action=add \u6284\u4E00\u6761\uFF08text \u5FC5\u586B\uFF09\uFF1Baction=list \u7FFB\u6700\u8FD1\u5341\u6761\uFF1Baction=remove \u62B9\u6389\u4E00\u6761\uFF08key \u4E3A #id \u6216\u6B63\u6587\u91CC\u7684\u552F\u4E00\u5B50\u4E32\uFF09\u3002',
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "list", "remove"], description: "add=\u6284\u4E00\u6761\uFF0Clist=\u7FFB\u6700\u8FD1\u5341\u6761\uFF0Cremove=\u62B9\u6389\u4E00\u6761" },
        text: { type: "string", description: "action=add \u65F6\u5FC5\u586B\uFF1A\u8981\u7559\u4E0B\u7684\u90A3\u53E5\u8BDD\u6216\u90A3\u4EF6\u5C0F\u4E8B" },
        key: { type: "string", description: "action=remove \u65F6\u5FC5\u586B\uFF1A#id \u6216\u6B63\u6587\u91CC\u7684\u552F\u4E00\u5B50\u4E32" }
      },
      required: ["action"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          message: { type: "string" }
        },
        required: ["ok", "message"],
        additionalProperties: false
      },
      render: (_args, value) => {
        const v = value;
        return [{ type: "text", text: String(v.message ?? "") }];
      }
    },
    timeoutMs: 5e3,
    // Read-modify-write on one file; never parallel.
    isConcurrencySafe: () => false,
    async execute(args) {
      const a = args ?? {};
      const action = String(a.action ?? "");
      if (action === "add") {
        const text = clean3(a.text).slice(0, MAX_TEXT2);
        if (!text) return { ok: false, message: "add \u9700\u8981\u975E\u7A7A text" };
        const e = appendExcerpt(guard, file, text);
        return { ok: true, message: `\u5DF2\u6284\u4E0B ${fmtEntry2(e)}` };
      }
      if (action === "remove") {
        const key = clean3(a.key);
        if (!key) return { ok: false, message: "remove \u9700\u8981 key\uFF08#id \u6216\u6B63\u6587\u91CC\u7684\u552F\u4E00\u5B50\u4E32\uFF09" };
        const e = removeExcerpt(guard, file, key);
        if (!e) return { ok: false, message: `\u6458\u6284\u672C\u91CC\u6CA1\u6709\u5339\u914D\u300C${key}\u300D\u7684\u4E00\u6761\uFF08\u5148\u7528 list \u7FFB\uFF09` };
        return { ok: true, message: `\u5DF2\u62B9\u6389 ${fmtEntry2(e)}` };
      }
      if (action === "list") {
        const total2 = readExcerpts(guard, file).entries.length;
        if (total2 === 0) return { ok: true, message: "\u6458\u6284\u672C\u8FD8\u662F\u7A7A\u7684" };
        const items = recentExcerpts(guard, file, LIST_LIMIT).map(fmtEntry2);
        return { ok: true, message: `\u6458\u6284\u672C\u5171 ${total2} \u6761\uFF0C\u6700\u8FD1 ${items.length} \u6761\uFF1A
${items.join("\n")}` };
      }
      const total = readExcerpts(guard, file).entries.length;
      return { ok: false, message: `\u672A\u77E5 action\uFF0C\u6458\u6284\u672C\u5171 ${total} \u6761` };
    }
  };
}

// src/index.ts
var name = "heartbeat";
var inject = ["agents", "settings"];
var Config = z.object({
  /** Override the runtime data dir (workspace guard boundary). Empty = default (<packageRoot>/data). */
  dataDir: z.string().default(""),
  /** UI-editable: heartbeat interval in minutes. 0 = use policy file / factory. */
  intervalMin: z.number().default(0),
  /** UI-editable: daily expression cap. 0 = use policy file / factory. */
  maxDailySend: z.number().default(0),
  /**
   * Agent preset the heartbeat agent joins (`<dshHome>/.agent-presets/<id>/`).
   * Without a preset the agent is a BARE agent: tools/prompt sections resolve
   * against the empty global layer, so it cannot even see `web_search`.
   */
  agentPreset: z.string().default("heartbeat"),
  /**
   * Install the bundled preset (see `agentPreset`) into the roster's user root
   * on first run, so setup needs no manual file copy. An existing preset is
   * never overwritten; set false to manage the preset entirely by hand.
   */
  installPreset: z.boolean().default(true),
  /** Self-built time injection interval (D20, §17.6). 0 disables injection.
   *  Left OPTIONAL on purpose (2026-10-17): a schema default here is
   *  indistinguishable from an explicit choice, and `applySettingsOverrides`
   *  applies this value over ui.json — so a default would silently undo the
   *  card on every reload. Unset falls back at the refs below. */
  timeInjectMin: z.number(),
  /** IANA timezone for the injected clock; empty = process zone. */
  timeZone: z.string().default(""),
  /** Statusbar master switch (D19). Off = no section/pre-step status; time injection unaffected. */
  statusbar: z.boolean(),
  /** v1.6.3 闲着模式：素材池为空时用画像话题兜底主动搭话（默认关）。 */
  idleMode: z.boolean(),
  /** v1.7.0 节省 token 模式：用户离开（闲置 ≥30 分钟）或锁屏时整跳暂停（默认关）。 */
  tokenSaver: z.boolean(),
  /** v1.8.0 账本工具：向所有日常会话 agent 注册共享账本工具（默认开）。 */
  ledgerTool: z.boolean().default(true),
  /** v1.9.0 素材报账工具：投递后由陪伴 agent 主动报账（默认开）。 */
  seedReportTool: z.boolean().default(true),
  /** v2.0.0 心事匣工具：留给下一跳的一句便签（默认开）。 */
  notepadTool: z.boolean().default(true),
  /** v2.0.0 摘抄本工具：留句子和小事的地方（默认开）。 */
  excerptTool: z.boolean().default(true),
  /** v1.8.0 引擎室追加工具：逗号分隔的全局工具名，存在才加入白名单（bili 压缩工具自动探测，无需手填）。 */
  extraTools: z.string().default("")
});
function apply(ctx, config = {}) {
  const paths = initWorkspace(config.dataDir ? { dataDir: config.dataDir } : {});
  const guard = createPathGuard(paths.dataDir);
  let policy = loadPolicy(guard, paths.configDir, paths.settingsDir);
  const ui = loadUiConfig(guard, paths.settingsDir);
  if (ui.intervalMin && ui.intervalMin >= 1) {
    policy = { ...policy, heartbeat: { ...policy.heartbeat, intervalMin: ui.intervalMin } };
  }
  if (ui.maxDailySend && ui.maxDailySend >= 1) {
    policy = { ...policy, gate: { ...policy.gate, maxDailySend: ui.maxDailySend } };
  }
  if (config.intervalMin && config.intervalMin >= 1) {
    policy = { ...policy, heartbeat: { ...policy.heartbeat, intervalMin: config.intervalMin } };
  }
  if (config.maxDailySend && config.maxDailySend >= 1) {
    policy = { ...policy, gate: { ...policy.gate, maxDailySend: config.maxDailySend } };
  }
  const deps = {
    ctx,
    paths,
    guard,
    policy,
    agentPreset: config.agentPreset || "heartbeat",
    extraTools: (config.extraTools ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    presetRegistration: () => presetRegistration ?? Promise.resolve()
  };
  setRuntime({
    paths,
    guard,
    policy,
    flags: {
      statusbarEnabled: () => statusbarEnabledRef,
      timeInjectMin: () => timeInjectMinRef,
      idleMode: () => idleModeRef,
      tokenSaver: () => tokenSaverRef
    }
  });
  let presetRegistration;
  let presetDisposer;
  let presetDisposed = false;
  ctx.inject(["agentPresets"], (presetCtx) => {
    const service = presetCtx.agentPresets;
    const presetId = config.agentPreset || "heartbeat";
    const installEnabled = config.installPreset !== false;
    const audit = (entry) => {
      try {
        appendAuditLine(guard.assert(paths.logsDir + "/heartbeat.jsonl"), entry);
      } catch (e) {
        ctx.logger.warn("heartbeat: preset audit failed (%s)", String(e).slice(0, 120));
      }
    };
    presetRegistration = registerHeartbeatPreset(service, presetId, installEnabled).then((result2) => {
      audit({ event: "preset_register", ...result2 });
      if (typeof result2.disposer === "function") {
        if (presetDisposed) {
          void Promise.resolve(result2.disposer()).catch((e) => {
            ctx.logger.warn("heartbeat: preset dispose failed (%s)", String(e).slice(0, 120));
          });
        } else {
          presetDisposer = result2.disposer;
        }
      }
      if (result2.action === "error") {
        ctx.logger.warn("heartbeat: preset register failed (%s) \u2014 the engine room runs without it", result2.detail ?? "");
      } else if (result2.action === "registered") {
        ctx.logger.info("heartbeat: preset %s registered at runtime", result2.id);
      } else {
        ctx.logger.info("heartbeat: preset registration skipped (%s)", result2.action);
      }
    });
    const root = userPresetRoot(service?.roots);
    const result = installBundledPreset({
      moduleUrl: import.meta.url,
      id: presetId,
      ...root === void 0 ? { rosterKnown: service !== void 0 } : { root },
      enabled: installEnabled
    });
    audit({ event: "preset_install", ...result });
    const line = describeInstall(result);
    if (result.action === "error" || result.action === "skipped-no-root") {
      ctx.logger.warn("heartbeat: %s", line);
    } else {
      ctx.logger.info("heartbeat: %s", line);
    }
  });
  let sectionSource = null;
  let timeInjectMinRef = ui.timeInjectMin ?? (config.timeInjectMin ?? 25);
  let statusbarEnabledRef = ui.statusbar ?? config.statusbar === true;
  let idleModeRef = ui.idleMode ?? config.idleMode === true;
  let tokenSaverRef = ui.tokenSaver ?? config.tokenSaver === true;
  const applyLiveSettings = (v) => {
    if (v.intervalMin && v.intervalMin >= 1) applyHeartbeatInterval(deps, v.intervalMin);
    if (v.maxDailySend && v.maxDailySend >= 1) getRuntime().policy.gate.maxDailySend = v.maxDailySend;
    if (typeof v.timeInjectMin === "number" && v.timeInjectMin >= 0) timeInjectMinRef = v.timeInjectMin;
    if (typeof v.statusbar === "boolean") statusbarEnabledRef = v.statusbar;
    if (typeof v.idleMode === "boolean") {
      idleModeRef = v.idleMode;
      getRuntime().policy.heartbeat.idleMode = v.idleMode;
    }
    if (typeof v.tokenSaver === "boolean") tokenSaverRef = v.tokenSaver;
  };
  const applySettingsOverrides = () => {
    try {
      const v = sectionSource?.();
      if (!v) return;
      applyLiveSettings(v);
      ctx.logger.info("heartbeat: settings overrides live (interval %s, cap %s, timeInject %s)", v.intervalMin ?? "-", v.maxDailySend ?? "-", v.timeInjectMin ?? "-");
    } catch (e) {
      ctx.logger.warn("heartbeat: settings override failed (%s)", String(e).slice(0, 120));
    }
  };
  void (async () => {
    try {
      const settingsService = ctx.get("settings");
      if (settingsService && typeof settingsService.installSection === "function") {
        settingsService.installSection(ctx, "heartbeat", Config, config, {
          setSource: (current) => {
            sectionSource = current;
          },
          onChange: () => {
            applySettingsOverrides();
          }
        });
        applySettingsOverrides();
        ctx.logger.info("heartbeat: settings section registered (0.1.5 settings service)");
        return;
      }
      if (settingsService && typeof settingsService.describe === "function") {
        sectionSource = () => config;
        applySettingsOverrides();
        ctx.logger.info("heartbeat: config served by the 0.1.7 profile form (edits reload the plugin)");
        return;
      }
      const legacy = await import("@deepseek-ai/dsh-settings");
      if (typeof legacy.installSettingsSection === "function" && typeof legacy.settingsNamespace === "function") {
        legacy.installSettingsSection(ctx, legacy.settingsNamespace("heartbeat"), Config, config, {
          setSource: (current) => {
            sectionSource = current;
          },
          onChange: () => {
            applySettingsOverrides();
          }
        });
        applySettingsOverrides();
        ctx.logger.info("heartbeat: settings section registered (legacy 0.1.1 settings)");
        return;
      }
      ctx.logger.warn("heartbeat: no settings integration found; policy file values only");
    } catch (e) {
      ctx.logger.warn("heartbeat: settings section unavailable (%s)", String(e).slice(0, 120));
    }
  })();
  appendAuditLine(
    guard.assert(paths.logsDir + "/heartbeat.jsonl"),
    { event: "plugin_init", dataDir: paths.dataDir }
  );
  if (paths.relocation) {
    const auditFile = guard.assert(paths.logsDir + "/heartbeat.jsonl");
    if (paths.relocation.action === "relocated") {
      appendAuditLine(auditFile, {
        event: "data_dir_relocated",
        from: paths.relocation.srcDir,
        to: paths.relocation.dstDir,
        files: paths.relocation.files,
        bytes: paths.relocation.bytes,
        warnings: paths.relocation.warnings,
        leftovers: paths.relocation.leftovers
      });
      ctx.logger.info(
        "heartbeat: data dir moved out of the package (%s files, %s bytes)",
        paths.relocation.files,
        paths.relocation.bytes
      );
    } else if (paths.relocation.action === "failed") {
      appendAuditLine(auditFile, {
        event: "data_dir_relocate_failed",
        stage: paths.relocation.stage,
        problems: paths.relocation.problems
      });
      ctx.logger.warn(
        "heartbeat: data dir relocation failed (%s); continuing in the package dir",
        paths.relocation.stage
      );
    }
  }
  const uiGet = () => ({
    intervalMin: getRuntime().policy.heartbeat.intervalMin,
    maxDailySend: getRuntime().policy.gate.maxDailySend,
    timeInjectMin: timeInjectMinRef,
    statusbar: statusbarEnabledRef,
    idleMode: idleModeRef,
    tokenSaver: tokenSaverRef,
    psyEnabled: getRuntime().policy.profile.psyEnabled
  });
  const uiSet = (patch) => {
    if (typeof patch.psyEnabled === "boolean") {
      updateUserPolicy(guard, paths.settingsDir, { profile: { psyEnabled: patch.psyEnabled } });
      getRuntime().policy.profile.psyEnabled = patch.psyEnabled;
    }
    const merged = saveUiConfig(guard, paths.settingsDir, patch);
    applyLiveSettings(merged);
  };
  installHeartbeatRpc(ctx, { paths, guard, policy, ui: { get: uiGet, set: uiSet } });
  const registerGlobalTool = (name2, build) => {
    ctx.inject(["tools"], (scoped) => {
      const audit = (entry) => {
        try {
          appendAuditLine(guard.assert(paths.logsDir + "/heartbeat.jsonl"), entry);
        } catch {
        }
      };
      try {
        const tools = scoped.tools;
        if (!tools || typeof tools.register !== "function") throw new Error("ToolRuntime.register unavailable on this host");
        tools.register(build());
        audit({ event: `${name2}_tool_registered` });
      } catch (e) {
        audit({ event: `${name2}_tool_register_failed`, error: String(e).slice(0, 160) });
      }
    });
  };
  if (config.ledgerTool !== false) {
    registerGlobalTool("ledger", () => buildLedgerTool(guard, ledgerFilePath(paths.dataDir)));
  }
  if (config.seedReportTool !== false) {
    registerGlobalTool("seed_report", () => buildSeedReportTool(guard, reportFilePath(paths.dataDir)));
  }
  if (config.notepadTool !== false) {
    registerGlobalTool("notepad", () => buildNotepadTool(guard, notepadFilePath(paths.dataDir)));
  }
  if (config.excerptTool !== false) {
    registerGlobalTool("excerpt", () => buildExcerptTool(guard, excerptFilePath(paths.dataDir)));
  }
  startOrchestrator(deps);
  const statusReader = new StatusReader();
  registerStatusbarSection(ctx, guard, paths, {
    enabled: () => statusbarEnabledRef,
    reader: statusReader
  });
  ctx.effect(() => {
    registerTimeInjection(ctx, guard, paths.dataDir, {
      getTimeInjectMin: () => timeInjectMinRef,
      timeZone: config.timeZone || void 0,
      paths,
      logger: ctx.logger,
      onError: (e) => ctx.logger.warn("heartbeat: time injection skipped (%s)", String(e).slice(0, 120)),
      pinTrack: (sessionId, session) => {
        const track = pinTrack(sessionId, session);
        noteTrack(paths.logsDir + "/heartbeat.jsonl", sessionId, track);
        return track;
      },
      getStatusLine: (session, track) => {
        if (!statusbarEnabledRef) {
          noteTrack(paths.logsDir + "/heartbeat.jsonl", session.id, "off");
          return "";
        }
        return track === "pre-step" ? renderStatusText(statusReader.read(guard, paths)) : "";
      }
    });
    return void 0;
  }, "heartbeat: time injection");
  ctx.effect(() => {
    return () => {
      presetDisposed = true;
      const undoPreset = presetDisposer;
      presetDisposer = void 0;
      if (typeof undoPreset === "function") {
        void Promise.resolve(undoPreset()).catch((e) => {
          ctx.logger.warn("heartbeat: preset dispose failed (%s)", String(e).slice(0, 120));
        });
      }
      ctx.logger.info("heartbeat: disposed, timers cleaned up");
    };
  }, "heartbeat: lifecycle");
}
export {
  Config,
  apply,
  deepMerge,
  inject,
  name
};
//# sourceMappingURL=index.js.map