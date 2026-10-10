import {
  ARCHIVE_PREFIX,
  appendAuditLine,
  journalFilePath,
  replayJournal,
  snapshotFilePath
} from "./chunk-CUOSICYJ.js";
import {
  saveJson
} from "./chunk-K5Y6JP2B.js";

// src/profile/snapshot.ts
import fs from "fs";
import path from "path";
var SNAPSHOT_THRESHOLD = 5e3;
function snapshotDue(guard, dataDir, threshold = SNAPSHOT_THRESHOLD) {
  let lines = 0;
  try {
    const raw = fs.readFileSync(guard.assert(journalFilePath(dataDir)), "utf8");
    lines = raw.split("\n").filter((l) => l.trim()).length;
  } catch {
    return { needed: false, lines: 0 };
  }
  return { needed: lines >= threshold, lines };
}
function snapshotProfile(guard, dataDir, now = Date.now()) {
  const journalFile = journalFilePath(dataDir);
  let raw = "";
  try {
    raw = fs.readFileSync(guard.assert(journalFile), "utf8");
  } catch {
    return { ok: false, reason: "no journal" };
  }
  const liveRecords = raw.split("\n").filter((l) => l.trim());
  if (liveRecords.length === 0) return { ok: false, reason: "journal empty, nothing to fold" };
  const replayed = replayJournal(guard, dataDir);
  const lastTs = lastRecordTs(raw) ?? new Date(now).toISOString();
  const snapshot = {
    version: 1,
    baselineTs: lastTs,
    recordsFolded: replayed.records,
    doc: replayed.doc
  };
  saveJson(guard, snapshotFilePath(dataDir), snapshot);
  const stamp = new Date(now).toISOString().replace(/[-:T]/g, "").slice(0, 15);
  const archiveFile = `${ARCHIVE_PREFIX}${stamp}.jsonl`;
  fs.writeFileSync(path.join(dataDir, archiveFile), liveRecords.join("\n") + "\n", "utf8");
  fs.writeFileSync(guard.assert(journalFile), "", "utf8");
  return {
    ok: true,
    baselineTs: lastTs,
    folded: replayed.records,
    archiveFile,
    liveRemaining: 0
  };
}
function lastRecordTs(raw) {
  const lines = raw.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return String(JSON.parse(lines[i]).ts ?? "") || null;
    } catch {
    }
  }
  return null;
}
function snapshotIfDue(guard, dataDir, auditFile, why, now = Date.now()) {
  try {
    const { needed, lines } = snapshotDue(guard, dataDir);
    if (!needed) return;
    const report = snapshotProfile(guard, dataDir, now);
    appendAuditLine(auditFile, { event: "profile_snapshot", why, lines, ...report });
  } catch (e) {
    try {
      appendAuditLine(auditFile, { event: "profile_snapshot_failed", why, error: String(e).slice(0, 160) });
    } catch {
    }
  }
}

export {
  SNAPSHOT_THRESHOLD,
  snapshotDue,
  snapshotProfile,
  snapshotIfDue
};
//# sourceMappingURL=chunk-KB5SMG3F.js.map