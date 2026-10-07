import {
  loadJson,
  readText,
  saveJson,
  writeText
} from "./chunk-7TW6DD6Q.js";
import {
  atomicWriteFileSync
} from "./chunk-WRUTATW4.js";

// src/core/audit-log.ts
import fs from "fs";
import path from "path";
function appendAuditLine(file, event) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = JSON.stringify({ ts: event.ts ?? (/* @__PURE__ */ new Date()).toISOString(), ...event });
    fs.appendFileSync(file, line + "\n", "utf8");
  } catch (e) {
    process.stderr.write(`[heartbeat] audit append failed: ${file}: ${String(e)}
`);
  }
}
function readAuditLines(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  const raw = fs.readFileSync(file, "utf8");
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
  if (!fs.existsSync(file)) return 0;
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

// src/profile/store.ts
import path3 from "path";
import { randomUUID } from "crypto";
import fs3 from "fs";

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
import fs2 from "fs";
import path2 from "path";
function loadProfileSchema(paths) {
  const userPath = path2.join(paths.settingsDir, "profile-schema.json");
  const factoryPath = path2.join(paths.configDir, "profile-schema.json");
  const read = (file) => {
    try {
      const raw = JSON.parse(fs2.readFileSync(file, "utf8"));
      if (!raw.partitions) return { error: "partitions missing" };
      return { schema: raw, error: "" };
    } catch (e) {
      return { error: String(e) };
    }
  };
  const user = fs2.existsSync(userPath) ? read(userPath) : null;
  if (user?.schema) return { schema: user.schema, source: "user" };
  const factory = read(factoryPath);
  if (factory.schema) {
    return user ? {
      schema: factory.schema,
      source: "factory",
      fallbackReason: `user profile-schema.json unusable (${user.error}) \u2014 fell back to the factory copy`
    } : { schema: factory.schema, source: "factory" };
  }
  return {
    source: "none",
    fallbackReason: `no usable profile-schema.json (user: ${user?.error ?? "absent"}; factory: ${factory.error})`
  };
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
var DAY_MS = 864e5;
function profileFilePath(dataDir) {
  return path3.join(dataDir, "profile.json");
}
function journalFilePath(dataDir) {
  return path3.join(dataDir, "profile_journal.jsonl");
}
var SNAPSHOT_FILE = "profile_snapshot.json";
var ARCHIVE_PREFIX = "profile_journal.archive-";
function snapshotFilePath(dataDir) {
  return path3.join(dataDir, SNAPSHOT_FILE);
}
function loadSnapshot(guard, dataDir) {
  const snap = loadJson(guard, snapshotFilePath(dataDir));
  if (!snap || snap.version !== 1 || typeof snap.baselineTs !== "string" || !snap.doc?.partitions) return null;
  return snap;
}
function listArchiveFiles(guard, dataDir) {
  try {
    return fs3.readdirSync(guard.assert(dataDir)).filter((f) => f.startsWith(ARCHIVE_PREFIX) && f.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
}
function replayText(doc, text, baselineTs, stats) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed);
      if (baselineTs && rec.ts && String(rec.ts) <= baselineTs) continue;
      for (const op of rec.applied ?? []) applyOpPermissive(doc, op, rec.ts);
      stats.records += 1;
    } catch {
      const isLast = lines.slice(i + 1).every((l) => !l.trim());
      if (stats.isLive && isLast) {
        stats.truncatedTail = lines.length - i;
        break;
      }
    }
  }
}
function replayJournal(guard, dataDir) {
  const snap = loadSnapshot(guard, dataDir);
  const doc = snap ? snap.doc : emptyProfile();
  const baselineTs = snap?.baselineTs ?? "";
  const stats = { records: snap?.recordsFolded ?? 0, truncatedTail: 0, isLive: false };
  for (const file of listArchiveFiles(guard, dataDir)) {
    try {
      replayText(doc, fs3.readFileSync(path3.join(dataDir, file), "utf8"), baselineTs, { records: 0, truncatedTail: 0, isLive: false });
    } catch {
    }
  }
  stats.isLive = true;
  replayText(doc, readText(guard, journalFilePath(dataDir), ""), baselineTs, stats);
  return { doc, truncatedTail: stats.truncatedTail, records: stats.records };
}
function readJournalTexts(guard, dataDir) {
  const texts = [];
  for (const file of listArchiveFiles(guard, dataDir)) {
    try {
      texts.push(fs3.readFileSync(path3.join(dataDir, file), "utf8"));
    } catch {
    }
  }
  texts.push(readText(guard, journalFilePath(dataDir), ""));
  return texts;
}
function loadProfile(guard, file) {
  const doc = loadJson(guard, file);
  if (!doc || !doc.partitions) return emptyProfile();
  for (const p of PARTITIONS) {
    if (!doc.partitions[p]) doc.partitions[p] = { entries: [] };
  }
  return doc;
}
function parseIso(v) {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}
function refExists(guard, dataDir, ref) {
  const base = ref.split("#")[0] ?? "";
  if (!base) return false;
  const target = path3.join(dataDir, base);
  try {
    return fs3.existsSync(guard.assert(target));
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
      let temporal = "stable";
      if (schema) {
        const check = checkAddAgainstSchema(schema, op.partition, op.topic, op.subTopic, op.temporal);
        if (!check.ok) {
          rejected.push({ op, reason: check.reason });
          continue;
        }
        temporal = check.temporal;
      } else if (!(op.partition in doc.partitions)) {
        rejected.push({ op, reason: `unknown partition: ${op.partition}` });
        continue;
      } else {
        temporal = op.temporal === "volatile" ? "volatile" : "stable";
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
        id: `p${dbSeq.toString(36)}${randomUUID().slice(0, 4)}`,
        partition: op.partition,
        topic: op.topic,
        subTopic: op.subTopic,
        content: op.content.trim(),
        confidence: Math.min(op.confidence ?? cap, cap),
        temporal,
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
      const hasNewObservation = (op.evidence ?? []).length > 0 && (op.evidence ?? []).some((e) => parseIso(e.at) > parseIso(entry.evidence[entry.evidence.length - 1]?.at ?? ""));
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
      const lastEvidence = Math.max(...e.evidence.map((x) => parseIso(x.at)), parseIso(e.updatedAt));
      if (e.temporal === "volatile") {
        if (now - lastEvidence > policy.profile.volatileDays * DAY_MS) {
          e.validTo = nowIso;
          e.updatedAt = nowIso;
          e.updateCount += 1;
          volatileExpired += 1;
        }
      } else if (!e.lowActivity && now - lastEvidence > policy.profile.stableLowActivityDays * DAY_MS) {
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
    fs3.appendFileSync(guard.assert(journal), line + "\n", "utf8");
  } catch {
    fs3.mkdirSync(dataDir, { recursive: true });
    fs3.appendFileSync(guard.assert(journal), line + "\n", "utf8");
  }
}
function applyOpPermissive(doc, op, ts) {
  if (op.op === "ADD") {
    dbSeq += 1;
    doc.partitions[op.partition].entries.push({
      id: op.assignedId ?? `r${dbSeq.toString(36)}${randomUUID().slice(0, 4)}`,
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
  if (opts.check) {
    const onDisk = loadProfile(guard, target);
    const same = JSON.stringify(onDisk) === JSON.stringify(replayed.doc);
    return {
      ok: same,
      truncatedTail: replayed.truncatedTail,
      records: replayed.records,
      wrote: false,
      diffSummary: same ? "no diff" : "materialized view differs from journal replay"
    };
  }
  saveJson(guard, target, replayed.doc);
  if (replayed.truncatedTail > 0) {
    writeText(
      guard,
      path3.join(dataDir, "logs", "rebuild-report.txt"),
      `rebuild truncated ${replayed.truncatedTail} torn line(s) at journal tail; ${replayed.records} records applied
`
    );
  }
  return { ok: true, truncatedTail: replayed.truncatedTail, records: replayed.records, wrote: true };
}

export {
  appendAuditLine,
  readAuditLines,
  pruneAuditFile,
  loadProfileSchema,
  profileFilePath,
  journalFilePath,
  ARCHIVE_PREFIX,
  snapshotFilePath,
  replayJournal,
  readJournalTexts,
  loadProfile,
  applyOpsToDoc,
  runDeterministicAging,
  persistWithJournal,
  verifyProfile,
  rebuildProfile
};
//# sourceMappingURL=chunk-OYVNWB5G.js.map