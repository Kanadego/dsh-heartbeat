import {
  loadEncryptedText,
  saveEncryptedText
} from "./chunk-LLD7LUNN.js";

// src/profile/inbox.ts
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
var MAX_NOTE_CHARS = 120;
function inboxFilePath(dataDir) {
  return path.join(dataDir, "profile_inbox.jsonl");
}
function truncateNote(note) {
  const oneLine = note.replace(/\r?\n/g, " ").trim();
  return oneLine.length > MAX_NOTE_CHARS ? oneLine.slice(0, MAX_NOTE_CHARS) + "\u2026" : oneLine;
}
function inboxAppend(guard, file, item) {
  const full = {
    id: item.id ?? randomUUID().slice(0, 8),
    kind: item.kind,
    at: item.at,
    ref: item.ref,
    note: truncateNote(item.note)
  };
  const prev = loadEncryptedText(guard, file) ?? "";
  saveEncryptedText(guard, file, prev + JSON.stringify(full) + "\n");
  return full;
}
function inboxCount(guard, file) {
  const raw = loadEncryptedText(guard, file);
  if (!raw) return 0;
  return raw.split("\n").filter((l) => l.trim()).length;
}
function inboxDrain(guard, file) {
  const raw = loadEncryptedText(guard, file);
  if (!raw) return [];
  const items = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      items.push(JSON.parse(trimmed));
    } catch {
    }
  }
  return items;
}
function inboxClear(guard, file) {
  saveEncryptedText(guard, file, "");
}
function dedupeItems(items) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const it of items) {
    const key = `${it.kind}#${it.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}
function inboxHealthCheck(guard, file) {
  const raw = loadEncryptedText(guard, file) ?? "";
  let total = 0;
  let corrupt = 0;
  const keys = /* @__PURE__ */ new Set();
  let duplicates = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const it = JSON.parse(trimmed);
      total += 1;
      const key = `${it.kind}#${it.ref}`;
      if (keys.has(key)) duplicates += 1;
      keys.add(key);
    } catch {
      corrupt += 1;
    }
  }
  return { total, corrupt, duplicates };
}
function inboxFileExists(guard, file) {
  return fs.existsSync(guard.assert(file));
}

export {
  inboxFilePath,
  inboxAppend,
  inboxCount,
  inboxDrain,
  inboxClear,
  dedupeItems,
  inboxHealthCheck,
  inboxFileExists
};
//# sourceMappingURL=chunk-4UE74TUB.js.map