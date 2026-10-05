import {
  isEncrypted,
  loadEncryptedText,
  saveEncryptedText
} from "./chunk-IFTFDHZX.js";

// src/vault/migrate.ts
import fs from "fs";
import path from "path";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from "crypto";
var MIGRATE_MAGIC = "HBMIG1";
var MIGRATE_VERSION = 1;
var KDF_N = 16384;
var KEY_LEN = 32;
var MIGRATE_FILES = [
  "profile.json",
  "profile_snapshot.json",
  "profile_inbox.jsonl",
  "profile_journal.jsonl",
  "profile_rhythm.json",
  "sent.json",
  "browse.json",
  "seeds.jsonl",
  "ledger.md",
  "cursors.json"
];
function collectWeeklyFiles(guard, paths) {
  const dir = path.join(paths.dataDir, "weekly");
  try {
    return fs.readdirSync(guard.assert(dir)).filter((f) => f.endsWith(".json")).map((f) => path.join("weekly", f).replace(/\\/g, "/"));
  } catch {
    return [];
  }
}
function collectJournalArchives(guard, paths) {
  try {
    return fs.readdirSync(guard.assert(paths.dataDir)).filter((f) => f.startsWith("profile_journal.archive-") && f.endsWith(".jsonl"));
  } catch {
    return [];
  }
}
function collectMigrationEntries(guard, paths) {
  const entries = [];
  const packed = [];
  const missing = [];
  const rels = [...MIGRATE_FILES, ...collectJournalArchives(guard, paths), ...collectWeeklyFiles(guard, paths)];
  for (const rel of rels) {
    const abs = path.join(paths.dataDir, rel);
    let absCanon;
    try {
      absCanon = guard.assert(abs);
    } catch {
      missing.push(rel);
      continue;
    }
    if (!fs.existsSync(absCanon)) {
      missing.push(rel);
      continue;
    }
    const encrypted = isEncrypted(absCanon);
    const content = encrypted ? loadEncryptedText(guard, absCanon) ?? (() => {
      throw new Error(`cannot decrypt ${rel} on this machine`);
    })() : fs.readFileSync(absCanon, "utf8");
    entries.push({ path: rel.replace(/\\/g, "/"), encrypted, content });
    packed.push(rel);
  }
  return { entries, progress: { packed, missing } };
}
function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, KEY_LEN, { N: KDF_N, r: 8, p: 1 });
}
function encryptContainer(entries, passphrase, now = /* @__PURE__ */ new Date()) {
  if (!passphrase) throw new Error("migrate: passphrase must not be empty");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plain = Buffer.from(JSON.stringify({ version: MIGRATE_VERSION, createdAt: now.toISOString(), files: entries }), "utf8");
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    magic: MIGRATE_MAGIC,
    kdf: { name: "scrypt", salt: salt.toString("hex"), N: KDF_N },
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    data: data.toString("base64")
  }, null, 1) + "\n";
}
function decryptContainer(text, passphrase) {
  let outer;
  try {
    outer = JSON.parse(text);
  } catch {
    throw new Error("migrate: not a migration container (bad JSON)");
  }
  if (outer.magic !== MIGRATE_MAGIC) throw new Error("migrate: not a migration container (bad magic)");
  const salt = Buffer.from(String(outer.kdf?.salt ?? ""), "hex");
  const iv = Buffer.from(String(outer.iv ?? ""), "hex");
  const tag = Buffer.from(String(outer.tag ?? ""), "hex");
  const data = Buffer.from(String(outer.data ?? ""), "base64");
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let plain;
  try {
    plain = Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    throw new Error("migrate: wrong passphrase or corrupted container");
  }
  const inner = JSON.parse(plain.toString("utf8"));
  if (inner.version !== MIGRATE_VERSION) throw new Error(`migrate: unsupported container version ${inner.version}`);
  if (!Array.isArray(inner.files)) throw new Error("migrate: container has no file list");
  const v = Buffer.from([inner.version]);
  timingSafeEqual(v, Buffer.from([MIGRATE_VERSION]));
  return { createdAt: inner.createdAt, files: inner.files };
}
function applyMigrationEntries(guard, paths, files, now = Date.now()) {
  const restored = [];
  const backedUp = [];
  const skipped = [];
  const stamp = new Date(now).toISOString().replace(/[-:T]/g, "").slice(0, 14);
  for (const f of files) {
    const rel = String(f.path ?? "");
    const abs = path.join(paths.dataDir, rel);
    let absCanon;
    try {
      absCanon = guard.assert(abs);
    } catch {
      skipped.push(rel);
      continue;
    }
    if (rel.includes("..") || path.isAbsolute(rel)) {
      skipped.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(absCanon), { recursive: true });
    if (fs.existsSync(absCanon)) {
      fs.copyFileSync(absCanon, `${absCanon}.bak-migrate-${stamp}`);
      backedUp.push(rel);
    }
    if (f.encrypted) saveEncryptedText(guard, absCanon, f.content);
    else fs.writeFileSync(absCanon, f.content, "utf8");
    restored.push(rel);
  }
  return { restored, backedUp, skipped };
}

export {
  MIGRATE_MAGIC,
  MIGRATE_VERSION,
  MIGRATE_FILES,
  collectMigrationEntries,
  encryptContainer,
  decryptContainer,
  applyMigrationEntries
};
//# sourceMappingURL=chunk-UCJR6TC7.js.map