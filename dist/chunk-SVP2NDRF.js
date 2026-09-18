import {
  loadEncryptedText,
  saveEncryptedText
} from "./chunk-LLD7LUNN.js";

// src/seeds/pool.ts
import path from "path";

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
var SEED_CATEGORY_CAPS = { topic: 16, chat: 14 };
var CATEGORY_VALUES = ["topic", "chat"];
function normalizeCategory(v) {
  return typeof v === "string" && CATEGORY_VALUES.includes(v) ? v : "topic";
}
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
  return path.join(dataDir, "seeds.jsonl");
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
        obj.category = normalizeCategory(obj.category);
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
function pickEvictionVictim(db, policy, now, category) {
  const actives = activeSeeds(db).filter((s) => category === void 0 || normalizeCategory(s.category) === category);
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
function retireLimit(s, policy) {
  return normalizeCategory(s.category) === "chat" ? 1 : policy.seeds.retireAfterUsed;
}
function addSeed(guard, file, policy, input, now = Date.now()) {
  const db = loadPool(guard, file);
  const text = input.text.trim();
  if (!text) throw new Error("seed text must not be empty");
  const tag = normalizeTag(input.tag);
  const source = input.source ?? "chat";
  const category = normalizeCategory(input.category ?? (source === "chat" ? "chat" : "topic"));
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
    kept.category = normalizeCategory(input.category ?? kept.category ?? category);
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
      const victim = pickEvictionVictim(db, policy, now, normalizeCategory(kept.category));
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
  const catCount = activeSeeds(db).filter((s) => normalizeCategory(s.category) === category).length;
  if (catCount >= SEED_CATEGORY_CAPS[category]) {
    const victim = pickEvictionVictim(db, policy, now, category);
    if (victim) {
      archiveSeed(victim, "pool_cap", now);
      evicted = victim;
    }
  }
  if (activeSeeds(db).length >= policy.seeds.maxActive) {
    const victim = pickEvictionVictim(db, policy, now, category);
    if (victim) {
      archiveSeed(victim, "pool_cap", now);
      evicted = evicted ?? victim;
    }
  }
  db.seq += 1;
  seed = {
    id: `s${db.seq}`,
    text,
    topic: input.topic ?? text.slice(0, 24),
    tag,
    source,
    category,
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
    if (s.used >= retireLimit(s, policy) && sinceEvidence <= sinceUsed) {
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
  if (s.used >= retireLimit(s, policy) && parseIso(s.lastEvidenceAt) <= parseIso(s.lastUsedAt)) {
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
function restoreSeed(guard, file, policy, id, now = Date.now()) {
  const db = loadPool(guard, file);
  const s = db.seeds.find((x) => x.id === id && x.status === "archived");
  if (!s) return { ok: false, reason: "archived seed not found" };
  if (activeSeeds(db).length >= policy.seeds.maxActive) {
    return { ok: false, reason: `pool full (${policy.seeds.maxActive}); archive something first` };
  }
  s.status = "active";
  s.retireReason = void 0;
  s.retiredAt = void 0;
  s.expiresAt = new Date(now + (policy.seeds.ttlDays[s.tag] || 14) * DAY_MS).toISOString();
  s.lastEvidenceAt = new Date(now).toISOString();
  savePool(guard, file, db);
  return { ok: true, seed: s };
}
function deleteSeed(guard, file, id) {
  const db = loadPool(guard, file);
  const before = db.seeds.length;
  db.seeds = db.seeds.filter((x) => x.id !== id);
  if (db.seeds.length === before) return false;
  savePool(guard, file, db);
  return true;
}

export {
  SEED_CATEGORY_CAPS,
  normalizeCategory,
  TTL_KEYS,
  normalizeTag,
  seedsFilePath,
  loadPool,
  savePool,
  activeSeeds,
  archivedSeeds,
  evictionScore,
  pickEvictionVictim,
  addSeed,
  gcPool,
  surfaceSeed,
  archiveSeedById,
  restoreSeed,
  deleteSeed
};
//# sourceMappingURL=chunk-SVP2NDRF.js.map