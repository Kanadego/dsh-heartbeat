import {
  loadEncryptedText,
  loadJson,
  readText,
  saveEncryptedText,
  saveJson,
  writeText
} from "./chunk-LLD7LUNN.js";

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

// src/core/audit-log.ts
import fs3 from "fs";
import path3 from "path";

// src/core/atomic-fs.ts
import fs2 from "fs";
import path2 from "path";
import { randomUUID, randomFillSync } from "crypto";
function tmpSibling(target, tag = "w") {
  return path2.join(
    path2.dirname(target),
    `.${path2.basename(target)}.${tag}-${randomUUID().slice(0, 8)}.tmp`
  );
}
function atomicWriteFileSync(target, data) {
  const tmp = tmpSibling(target);
  try {
    fs2.writeFileSync(tmp, data);
    fs2.renameSync(tmp, target);
  } finally {
    fs2.rmSync(tmp, { force: true });
  }
}
function atomicWriteJsonSync(target, value) {
  atomicWriteFileSync(target, JSON.stringify(value, null, 2));
}
function shredFileSync(target, passes = 3) {
  const stat = fs2.statSync(target);
  if (!stat.isFile()) throw new Error(`shred: not a file: ${target}`);
  const buf = Buffer.alloc(Math.max(stat.size, 1));
  for (let i = 0; i < passes; i++) {
    randomFillSync(buf);
    fs2.writeFileSync(target, buf);
  }
  fs2.rmSync(target, { force: true });
}

// src/core/audit-log.ts
function appendAuditLine(file, event) {
  fs3.mkdirSync(path3.dirname(file), { recursive: true });
  const line = JSON.stringify({ ts: event.ts ?? (/* @__PURE__ */ new Date()).toISOString(), ...event });
  fs3.appendFileSync(file, line + "\n", "utf8");
}
function readAuditLines(file) {
  if (!fs3.existsSync(file)) return [];
  const out = [];
  const raw = fs3.readFileSync(file, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      out.push({ ts: "", corrupt: true, raw: trimmed.slice(0, 200) });
    }
  }
  return out;
}
function pruneAuditFile(file, maxAgeMs, now = Date.now()) {
  if (!fs3.existsSync(file)) return 0;
  const lines = readAuditLines(file);
  const kept = lines.filter((e) => {
    const ev = e;
    const ts = Date.parse(ev.ts ?? "");
    if (!Number.isFinite(ts)) return true;
    return now - ts <= maxAgeMs;
  });
  const removed = lines.length - kept.length;
  if (removed === 0) return 0;
  const body = kept.map((e) => JSON.stringify(e)).join("\n");
  atomicWriteFileSync(file, body ? body + "\n" : "");
  return removed;
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
import fs4 from "fs";
import path4 from "path";
var USER_POLICY_FILE = "policy.json";
function loadPolicy(guard, configDir, settingsDir) {
  const factoryPath = path4.join(configDir, "policy.json");
  let factoryRaw;
  try {
    factoryRaw = JSON.parse(fs4.readFileSync(factoryPath, "utf8"));
  } catch (e) {
    throw new Error(`factory policy unreadable at ${factoryPath}: ${String(e)}`);
  }
  assertPolicy(factoryRaw);
  const userPath = guard.assert(path4.join(settingsDir, USER_POLICY_FILE));
  let merged = factoryRaw;
  if (fs4.existsSync(userPath)) {
    try {
      const userRaw = JSON.parse(fs4.readFileSync(userPath, "utf8"));
      merged = deepMerge(factoryRaw, userRaw);
    } catch (e) {
      throw new Error(`user policy layer unparseable at ${userPath}: ${String(e)}`);
    }
  }
  assertPolicy(merged);
  return merged;
}

// src/seeds/pool.ts
import path5 from "path";

// src/seeds/types.ts
function emptySeedDb() {
  return { seq: 0, seeds: [] };
}
var SEED_SOURCE_DEFAULT_CONFIDENCE = {
  hand: 1,
  profile: 0.7,
  chat: 0.6,
  screen: 0.4,
  browse: 0.4
};

// src/seeds/pool.ts
var DAY_MS = 864e5;
var TTL_KEYS = ["news", "fandom", "scene", "promise"];
function normalizeTag(tag) {
  if (tag && TTL_KEYS.includes(tag)) return tag;
  return "scene";
}
function parseIso(v) {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}
function seedsFilePath(dataDir) {
  return path5.join(dataDir, "seeds.jsonl");
}
function loadPool(guard, file) {
  const raw = loadEncryptedText(guard, file);
  if (raw === null) return emptySeedDb();
  const db = emptySeedDb();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj.id === "string" && obj.id.startsWith("s")) {
        db.seeds.push(obj);
        const n = Number(obj.id.slice(1));
        if (Number.isFinite(n) && n > db.seq) db.seq = n;
      }
    } catch {
    }
  }
  return db;
}
function savePool(guard, file, db) {
  const body = db.seeds.map((s) => JSON.stringify(s)).join("\n");
  saveEncryptedText(guard, file, body ? body + "\n" : "");
}
var activeSeeds = (db) => db.seeds.filter((s) => s.status === "active");
var archivedSeeds = (db) => db.seeds.filter((s) => s.status === "archived");
function evictionScore(seed, policy, now) {
  const ttlDays = policy.seeds.ttlDays[seed.tag] || 14;
  const daysStale = Math.max(0, (now - parseIso(seed.lastEvidenceAt)) / DAY_MS);
  const freshness = Math.max(0, 1 - daysStale / ttlDays);
  const unused = seed.used === 0 ? 1 : 1 / seed.used;
  const w = policy.seeds.scoreWeights;
  return freshness * w.freshness + unused * w.unused + seed.confidence * w.confidence;
}
function pickEvictionVictim(db, policy, now) {
  const actives = activeSeeds(db);
  if (actives.length === 0) return null;
  const unprotected = actives.filter((s) => !s.protected);
  const candidates = unprotected.length > 0 ? unprotected : actives;
  let worst = null;
  let worstScore = Number.POSITIVE_INFINITY;
  for (const s of candidates) {
    const score = evictionScore(s, policy, now);
    if (score < worstScore) {
      worstScore = score;
      worst = s;
    }
  }
  return worst;
}
function archiveSeed(seed, reason, now) {
  seed.status = "archived";
  seed.retireReason = reason;
  seed.retiredAt = new Date(now).toISOString();
}
function addSeed(guard, file, policy, input, now = Date.now()) {
  const db = loadPool(guard, file);
  const text = input.text.trim();
  if (!text) throw new Error("seed text must not be empty");
  const tag = normalizeTag(input.tag);
  const source = input.source ?? "chat";
  const confidence = input.confidence ?? SEED_SOURCE_DEFAULT_CONFIDENCE[source];
  const dup = activeSeeds(db).find((s) => s.text === text);
  if (dup) return { kind: "duplicate", seed: dup };
  const nowIso = new Date(now).toISOString();
  const ttlMs = (policy.seeds.ttlDays[tag] || 14) * DAY_MS;
  const sameTopic = activeSeeds(db).filter((s) => s.topic === (input.topic ?? text.slice(0, 24)));
  let seed;
  if (sameTopic.length > 0) {
    const kept = sameTopic[0];
    kept.text = text;
    kept.tag = tag;
    kept.source = source;
    kept.confidence = Math.max(kept.confidence, confidence);
    kept.used = sameTopic.reduce((acc, s) => acc + s.used, 0);
    kept.lastEvidenceAt = [kept.lastEvidenceAt, nowIso, ...sameTopic.map((s) => s.lastEvidenceAt)].reduce((a, b) => parseIso(b) > parseIso(a) ? b : a);
    kept.expiresAt = new Date(Math.max(parseIso(kept.expiresAt), now + ttlMs)).toISOString();
    kept.protected = kept.protected || source === "hand" || source === "profile" && confidence >= 0.7;
    for (const extra of sameTopic.slice(1)) {
      extra.status = "archived";
      extra.retireReason = "completed";
      extra.retiredAt = nowIso;
    }
    seed = kept;
    if (activeSeeds(db).length > policy.seeds.maxActive) {
      const victim = pickEvictionVictim(db, policy, now);
      if (victim && victim.id !== kept.id) {
        archiveSeed(victim, "pool_cap", now);
        savePool(guard, file, db);
        return { kind: "merged", seed: kept, evicted: victim };
      }
    }
    savePool(guard, file, db);
    return { kind: "merged", seed: kept };
  }
  let evicted;
  if (activeSeeds(db).length >= policy.seeds.maxActive) {
    const victim = pickEvictionVictim(db, policy, now);
    if (victim) {
      archiveSeed(victim, "pool_cap", now);
      evicted = victim;
    }
  }
  db.seq += 1;
  seed = {
    id: `s${db.seq}`,
    text,
    topic: input.topic ?? text.slice(0, 24),
    tag,
    source,
    confidence,
    protected: source === "hand" || source === "profile" && confidence >= 0.7,
    used: 0,
    bornAt: nowIso,
    expiresAt: new Date(now + ttlMs).toISOString(),
    lastUsedAt: null,
    lastEvidenceAt: nowIso,
    status: "active"
  };
  db.seeds.push(seed);
  savePool(guard, file, db);
  return { kind: "added", seed, evicted };
}
function gcPool(guard, file, policy, now = Date.now()) {
  const db = loadPool(guard, file);
  const report = { consumed: 0, expired: 0, coldBench: 0, activeAfter: 0 };
  for (const s of activeSeeds(db)) {
    const ageMs = now - parseIso(s.bornAt);
    const sinceEvidence = parseIso(s.lastEvidenceAt);
    const sinceUsed = s.lastUsedAt ? parseIso(s.lastUsedAt) : 0;
    if (s.used >= policy.seeds.retireAfterUsed && sinceEvidence <= sinceUsed) {
      archiveSeed(s, "consumed", now);
      report.consumed += 1;
    } else if (now > parseIso(s.expiresAt)) {
      archiveSeed(s, "expired", now);
      report.expired += 1;
    } else if (s.used === 0 && ageMs >= policy.seeds.coldBenchDays * DAY_MS) {
      archiveSeed(s, "cold_bench", now);
      report.coldBench += 1;
    }
  }
  report.activeAfter = activeSeeds(db).length;
  savePool(guard, file, db);
  return report;
}
function surfaceSeed(guard, file, policy, id, now = Date.now()) {
  const db = loadPool(guard, file);
  const s = db.seeds.find((x) => x.id === id && x.status === "active");
  if (!s) return null;
  s.used += 1;
  s.lastUsedAt = new Date(now).toISOString();
  if (s.used >= policy.seeds.retireAfterUsed && parseIso(s.lastEvidenceAt) <= parseIso(s.lastUsedAt)) {
    archiveSeed(s, "consumed", now);
  }
  savePool(guard, file, db);
  return s;
}
function archiveSeedById(guard, file, id, reason = "completed", now = Date.now()) {
  const db = loadPool(guard, file);
  const s = db.seeds.find((x) => x.id === id && x.status === "active");
  if (!s) return null;
  archiveSeed(s, reason, now);
  savePool(guard, file, db);
  return s;
}

// src/ledger/ledger.ts
import path6 from "path";
import { randomUUID as randomUUID2 } from "crypto";
var DAY_MS2 = 864e5;
function ledgerFilePath(dataDir) {
  return path6.join(dataDir, "ledger.md");
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
    id: randomUUID2().slice(0, 6),
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
  const out = rawLines.map((line) => {
    if (line.includes(`#${target.id}] `)) {
      return `- [${target.date} ${pad(d.getHours())}:${pad(d.getMinutes())}][done][#${target.id}] ${target.text}`;
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
  const cutoff = new Date(now - days * DAY_MS2).toISOString().slice(0, 10);
  return scanPending(guard, file, now).filter((e) => e.date <= cutoff);
}

// src/browse/browse.ts
import fs5 from "fs";
import path7 from "path";
var WATCH_THROTTLE_MS = 6 * 36e5;
var UA = { "User-Agent": "dsh-heartbeat/2.0 (+local; personal companion)" };
function emptyBrowseState() {
  return { targets: {}, last_check_at: 0, wander: { focusHistory: {}, focusCount: {}, last_wander_at: 0 } };
}
function browseStatePath(paths) {
  return path7.join(paths.dataDir, "browse.json");
}
function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs5.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function loadInterests(paths) {
  const userPath = path7.join(paths.settingsDir, "interests.json");
  if (fs5.existsSync(userPath)) return readJsonFile(userPath, { interests: [], _schedule: {} });
  return readJsonFile(path7.join(paths.configDir, "interests.json"), { interests: [], _schedule: {} });
}
function loadWatchlist(paths) {
  const userPath = path7.join(paths.settingsDir, "watchlist.json");
  if (fs5.existsSync(userPath)) return readJsonFile(userPath, { targets: [] });
  return readJsonFile(path7.join(paths.configDir, "watchlist.json"), { targets: [] });
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
function pickFocus(state, interests, now) {
  const sc = interests._schedule ?? {};
  const cooldown = sc.focus_cooldown_days ?? 3;
  const pool = (interests.interests ?? []).filter((t) => !onCooldown(state, t, cooldown, now));
  if (pool.length === 0) return null;
  pool.sort((a, b) => (state.wander.focusHistory[a] ?? 0) - (state.wander.focusHistory[b] ?? 0));
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
  const focus = pickFocus(state, interests, now.getTime());
  if (!focus) return { focus: null, query: null, skipped: "no-focus" };
  return { focus, query: `${focus} 2026 \u6700\u65B0`, skipped: null };
}
function completeWander(guard, paths, focus, now = Date.now()) {
  const state = loadState(guard, paths);
  state.wander.focusHistory[focus] = now;
  state.wander.focusCount[focus] = (state.wander.focusCount[focus] ?? 0) + 1;
  state.wander.last_wander_at = now;
  saveJson(guard, browseStatePath(paths), state);
  return { focus, count: state.wander.focusCount[focus] };
}
function browseStatus(guard, paths) {
  return loadState(guard, paths);
}

// src/profile/store.ts
import path9 from "path";
import { randomUUID as randomUUID3 } from "crypto";
import fs7 from "fs";

// src/profile/types.ts
var PARTITIONS = ["interest", "projects", "comm", "psy"];
var CONFIDENCE_CAP = {
  chat: 0.6,
  screen: 0.4,
  browse: 0.4,
  hand: 1,
  ledger: 0.6
};
function emptyProfile() {
  return {
    version: 1,
    partitions: { interest: { entries: [] }, projects: { entries: [] }, comm: { entries: [] }, psy: { entries: [] } }
  };
}

// src/profile/schema.ts
import fs6 from "fs";
import path8 from "path";
function loadProfileSchema(paths) {
  const userPath = path8.join(paths.settingsDir, "profile-schema.json");
  const file = fs6.existsSync(userPath) ? userPath : path8.join(paths.configDir, "profile-schema.json");
  try {
    const raw = JSON.parse(fs6.readFileSync(file, "utf8"));
    if (!raw.partitions) throw new Error("partitions missing");
    return raw;
  } catch (e) {
    throw new Error(`profile-schema unreadable at ${file}: ${String(e)}`);
  }
}
function checkAddAgainstSchema(schema, partition, topic, subTopic, nominated) {
  const p = schema.partitions[partition];
  if (!p) return { ok: false, reason: `partition not in schema: ${partition}`, temporal: "stable" };
  const t = p.topics[topic];
  if (!t) return { ok: false, reason: `topic not in schema: ${partition}/${topic}`, temporal: "stable" };
  const st = t.subtopics[subTopic];
  if (!st) return { ok: false, reason: `sub_topic not in schema: ${partition}/${topic}/${subTopic}`, temporal: "stable" };
  const allowed = st.allowed && st.allowed.length > 0 ? st.allowed : ["stable"];
  const def = st.default && allowed.includes(st.default) ? st.default : allowed[0];
  if (!nominated) return { ok: true, temporal: def };
  if (!allowed.includes(nominated)) {
    return {
      ok: false,
      reason: `temporal "${nominated}" not allowed for ${partition}/${topic}/${subTopic} (allowed: ${allowed.join("|")})`,
      temporal: def
    };
  }
  return { ok: true, temporal: nominated };
}

// src/profile/store.ts
var DAY_MS3 = 864e5;
function profileFilePath(dataDir) {
  return path9.join(dataDir, "profile.json");
}
function journalFilePath(dataDir) {
  return path9.join(dataDir, "profile_journal.jsonl");
}
function loadProfile(guard, file) {
  const doc = loadJson(guard, file);
  if (!doc || !doc.partitions) return emptyProfile();
  for (const p of PARTITIONS) {
    if (!doc.partitions[p]) doc.partitions[p] = { entries: [] };
  }
  return doc;
}
function parseIso2(v) {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}
function refExists(guard, dataDir, ref) {
  const base = ref.split("#")[0] ?? "";
  if (!base) return false;
  const target = path9.join(dataDir, base);
  try {
    return fs7.existsSync(guard.assert(target));
  } catch {
    return false;
  }
}
function capForKinds(kinds) {
  if (kinds.length === 0) return 0.4;
  return Math.min(...kinds.map((k) => CONFIDENCE_CAP[k] ?? 0.4));
}
function findActive(doc, id) {
  for (const p of PARTITIONS) {
    const hit = doc.partitions[p].entries.find((e) => e.id === id && e.validTo === null);
    if (hit) return hit;
  }
  return void 0;
}
function applyOpsToDoc(guard, dataDir, doc, ops, schema, policy, now) {
  const applied = [];
  const rejected = [];
  const nowIso = new Date(now).toISOString();
  for (const op of ops) {
    if (op.op === "NOOP") {
      applied.push(op);
      continue;
    }
    if (op.op === "ADD") {
      if (op.partition === "psy" && !policy.profile.psyEnabled) {
        rejected.push({ op, reason: "psy partition is disabled" });
        continue;
      }
      const check = checkAddAgainstSchema(schema, op.partition, op.topic, op.subTopic, op.temporal);
      if (!check.ok) {
        rejected.push({ op, reason: check.reason });
        continue;
      }
      if (!op.evidence || op.evidence.length === 0) {
        rejected.push({ op, reason: "ADD without evidence (no provenance, axiom 1)" });
        continue;
      }
      const badRef = op.evidence.find((e) => !refExists(guard, dataDir, e.ref));
      if (badRef) {
        rejected.push({ op, reason: `evidence ref does not resolve: ${badRef.ref}` });
        continue;
      }
      const cap = capForKinds(op.evidence.map((e) => e.kind));
      const active = doc.partitions[op.partition].entries.filter((e) => e.validTo === null);
      if (active.length >= policy.profile.partitionCap) {
        rejected.push({ op, reason: `partition ${op.partition} at cap (${policy.profile.partitionCap}); converge first` });
        continue;
      }
      dbSeq += 1;
      const entry = {
        id: `p${dbSeq.toString(36)}${randomUUID3().slice(0, 4)}`,
        partition: op.partition,
        topic: op.topic,
        subTopic: op.subTopic,
        content: op.content.trim(),
        confidence: Math.min(op.confidence ?? cap, cap),
        temporal: check.temporal,
        validFrom: nowIso,
        validTo: null,
        supersededBy: null,
        evidence: op.evidence,
        createdAt: nowIso,
        updatedAt: nowIso,
        updateCount: 0
      };
      op.assignedId = entry.id;
      doc.partitions[op.partition].entries.push(entry);
      applied.push(op);
      continue;
    }
    if (op.op === "UPDATE") {
      const entry = findActive(doc, op.id);
      if (!entry) {
        rejected.push({ op, reason: `unknown or inactive entry: ${op.id}` });
        continue;
      }
      if (op.changes.content !== void 0) entry.content = op.changes.content.trim();
      if (op.changes.confidence !== void 0) {
        const cap = capForKinds(entry.evidence.map((e) => e.kind));
        if (op.changes.confidence > entry.confidence && entry.evidence.length < 2) {
          rejected.push({ op, reason: "confidence upgrade requires a second confirming observation" });
          continue;
        }
        entry.confidence = Math.min(op.changes.confidence, cap);
      }
      entry.updatedAt = nowIso;
      entry.updateCount += 1;
      applied.push(op);
      continue;
    }
    if (op.op === "INVALIDATE") {
      const entry = findActive(doc, op.id);
      if (!entry) {
        rejected.push({ op, reason: `unknown or inactive entry: ${op.id}` });
        continue;
      }
      if (entry.temporal === "volatile") {
        rejected.push({ op, reason: "volatile expiry is code-owned (time-driven), not LLM-nominated" });
        continue;
      }
      const hasNewObservation = (op.evidence ?? []).length > 0 && (op.evidence ?? []).some((e) => parseIso2(e.at) > parseIso2(entry.evidence[entry.evidence.length - 1]?.at ?? ""));
      if (!hasNewObservation) {
        rejected.push({ op, reason: "stable INVALIDATE requires a newer contradicting observation" });
        continue;
      }
      entry.validTo = nowIso;
      entry.supersededBy = null;
      entry.updatedAt = nowIso;
      entry.updateCount += 1;
      if (op.evidence) entry.evidence.push(...op.evidence);
      applied.push(op);
      continue;
    }
  }
  return { applied, rejected };
}
var dbSeq = 0;
function runDeterministicAging(doc, policy, now) {
  const nowIso = new Date(now).toISOString();
  let volatileExpired = 0;
  let lowActivityMarked = 0;
  for (const p of PARTITIONS) {
    for (const e of doc.partitions[p].entries) {
      if (e.validTo !== null) continue;
      const lastEvidence = Math.max(...e.evidence.map((x) => parseIso2(x.at)), parseIso2(e.updatedAt));
      if (e.temporal === "volatile") {
        if (now - lastEvidence > policy.profile.volatileDays * DAY_MS3) {
          e.validTo = nowIso;
          e.updatedAt = nowIso;
          e.updateCount += 1;
          volatileExpired += 1;
        }
      } else if (!e.lowActivity && now - lastEvidence > policy.profile.stableLowActivityDays * DAY_MS3) {
        e.lowActivity = true;
        lowActivityMarked += 1;
      }
    }
  }
  return { volatileExpired, lowActivityMarked };
}
function persistWithJournal(guard, dataDir, doc, record) {
  saveJson(guard, profileFilePath(dataDir), doc);
  const line = JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), ...record });
  const journal = journalFilePath(dataDir);
  try {
    fs7.appendFileSync(guard.assert(journal), line + "\n", "utf8");
  } catch {
    fs7.mkdirSync(dataDir, { recursive: true });
    fs7.appendFileSync(guard.assert(journal), line + "\n", "utf8");
  }
}
function applyOpPermissive(doc, op, ts) {
  if (op.op === "ADD") {
    dbSeq += 1;
    doc.partitions[op.partition].entries.push({
      id: op.assignedId ?? `r${dbSeq.toString(36)}${randomUUID3().slice(0, 4)}`,
      partition: op.partition,
      topic: op.topic,
      subTopic: op.subTopic,
      content: op.content,
      confidence: op.confidence ?? 0.5,
      temporal: op.temporal ?? "stable",
      validFrom: ts,
      validTo: null,
      supersededBy: null,
      evidence: op.evidence,
      createdAt: ts,
      updatedAt: ts,
      updateCount: 0
    });
    return;
  }
  if (op.op === "UPDATE") {
    const e = [...PARTITIONS].flatMap((p) => doc.partitions[p].entries).find((x) => x.id === op.id);
    if (e) {
      if (op.changes.content !== void 0) e.content = op.changes.content;
      if (op.changes.confidence !== void 0) e.confidence = op.changes.confidence;
      e.updatedAt = ts;
      e.updateCount += 1;
    }
    return;
  }
  if (op.op === "INVALIDATE") {
    const e = [...PARTITIONS].flatMap((p) => doc.partitions[p].entries).find((x) => x.id === op.id);
    if (e) {
      e.validTo = ts;
      e.updatedAt = ts;
      e.updateCount += 1;
    }
  }
}
function replayJournal(guard, dataDir) {
  const journal = journalFilePath(dataDir);
  const raw = readText(guard, journal, "");
  const doc = emptyProfile();
  let records = 0;
  let truncatedTail = 0;
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed);
      for (const op of rec.applied ?? []) applyOpPermissive(doc, op, rec.ts);
      records += 1;
    } catch {
      const isLast = lines.slice(i + 1).every((l) => !l.trim());
      if (isLast) {
        truncatedTail = lines.length - i;
        break;
      }
    }
  }
  return { doc, truncatedTail, records };
}
function verifyProfile(guard, dataDir) {
  const replayed = replayJournal(guard, dataDir);
  const onDisk = loadProfile(guard, profileFilePath(dataDir));
  const strip = (doc) => JSON.stringify(doc.partitions, (k, v) => ["id", "supersededBy", "validFrom", "createdAt", "updatedAt", "retiredAt"].includes(k) ? "<norm>" : v);
  const ok = strip(replayed.doc) === strip(onDisk);
  if (ok) return { ok: true, truncatedTail: replayed.truncatedTail, records: replayed.records };
  const diskIds = new Set([...PARTITIONS].flatMap((p) => onDisk.partitions[p].entries.map((e) => e.content)));
  const replayIds = new Set([...PARTITIONS].flatMap((p) => replayed.doc.partitions[p].entries.map((e) => e.content)));
  const onlyDisk = [...diskIds].find((c) => !replayIds.has(c));
  const onlyReplay = [...replayIds].find((c) => !diskIds.has(c));
  return {
    ok: false,
    firstDivergence: {
      id: onlyDisk ?? onlyReplay ?? "(content)",
      expected: onlyReplay ? "absent in journal replay" : "present in journal replay",
      actual: onlyDisk ? "present on disk" : "absent on disk"
    },
    truncatedTail: replayed.truncatedTail,
    records: replayed.records
  };
}
function rebuildProfile(guard, dataDir, opts = {}) {
  const replayed = replayJournal(guard, dataDir);
  const target = profileFilePath(dataDir);
  const tmp = path9.join(dataDir, `.profile.rebuild.${Date.now()}.tmp`);
  atomicWriteFileSync(tmp, JSON.stringify(replayed.doc, null, 2));
  if (opts.check) {
    const onDisk = loadProfile(guard, target);
    const same = JSON.stringify(onDisk) === JSON.stringify(replayed.doc);
    fs7.rmSync(tmp, { force: true });
    return {
      ok: same,
      truncatedTail: replayed.truncatedTail,
      records: replayed.records,
      wrote: false,
      diffSummary: same ? "no diff" : "materialized view differs from journal replay"
    };
  }
  fs7.renameSync(tmp, target);
  if (replayed.truncatedTail > 0) {
    writeText(
      guard,
      path9.join(dataDir, "logs", "rebuild-report.txt"),
      `rebuild truncated ${replayed.truncatedTail} torn line(s) at journal tail; ${replayed.records} records applied
`
    );
  }
  return { ok: true, truncatedTail: replayed.truncatedTail, records: replayed.records, wrote: true };
}

// src/notify/notify.ts
import { spawnSync } from "child_process";
import path10 from "path";
function runNotify(paths, args) {
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path10.join(paths.assetsDir, "notify.ps1"), ...args],
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

export {
  createPathGuard,
  atomicWriteJsonSync,
  shredFileSync,
  appendAuditLine,
  pruneAuditFile,
  deepMerge,
  loadPolicy,
  seedsFilePath,
  loadPool,
  activeSeeds,
  archivedSeeds,
  addSeed,
  gcPool,
  surfaceSeed,
  archiveSeedById,
  ledgerFilePath,
  readLedger,
  appendEntry,
  markDone,
  scanPending,
  pendingOlderThan,
  loadInterests,
  loadWatchlist,
  checkWatchlist,
  adviseWander,
  completeWander,
  browseStatus,
  loadProfileSchema,
  profileFilePath,
  loadProfile,
  applyOpsToDoc,
  runDeterministicAging,
  persistWithJournal,
  verifyProfile,
  rebuildProfile,
  ensureRegistered,
  sendNewMessageHint
};
//# sourceMappingURL=chunk-5K32NJ72.js.map