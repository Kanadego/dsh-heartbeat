import {
  withFileLock
} from "./chunk-IV2ZWQA3.js";
import {
  loadEncryptedText,
  saveEncryptedText
} from "./chunk-K5Y6JP2B.js";

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
var NO_AUDIT = () => {
};
function emit(audit, entry) {
  try {
    audit(entry);
  } catch {
  }
}
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
function update(guard, file, fn) {
  return withFileLock(file, () => fn(loadPool(guard, file)));
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
function isConsumed(s, policy, prevUsedAt, sinceEvidence) {
  if (s.used < retireLimit(s, policy)) return false;
  return !(prevUsedAt > 0 && sinceEvidence > prevUsedAt);
}
function addSeed(guard, file, policy, input, now = Date.now(), audit = NO_AUDIT) {
  return withFileLock(file, () => addSeedLocked(guard, file, policy, input, now, audit));
}
function addSeedLocked(guard, file, policy, input, now, audit) {
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
      emit(audit, { event: "seed_retired", id: extra.id, reason: "completed", via: "merge", into: kept.id });
    }
    seed = kept;
    if (activeSeeds(db).length > policy.seeds.maxActive) {
      const victim = pickEvictionVictim(db, policy, now, normalizeCategory(kept.category));
      if (victim && victim.id !== kept.id) {
        archiveSeed(victim, "pool_cap", now);
        emit(audit, { event: "seed_added", id: kept.id, kind: "merged", tag: kept.tag, source: kept.source, category: kept.category, confidence: kept.confidence, mergedFrom: sameTopic.length - 1 });
        emit(audit, { event: "seed_retired", id: victim.id, reason: "pool_cap", via: "merge", into: kept.id });
        savePool(guard, file, db);
        return { kind: "merged", seed: kept, evicted: victim };
      }
    }
    emit(audit, { event: "seed_added", id: kept.id, kind: "merged", tag: kept.tag, source: kept.source, category: kept.category, confidence: kept.confidence, mergedFrom: sameTopic.length - 1 });
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
  emit(audit, { event: "seed_added", id: seed.id, kind: "added", tag: seed.tag, source: seed.source, category: seed.category, confidence: seed.confidence });
  if (evicted) emit(audit, { event: "seed_retired", id: evicted.id, reason: "pool_cap", via: "add", into: seed.id });
  savePool(guard, file, db);
  return { kind: "added", seed, evicted };
}
function gcPool(guard, file, policy, now = Date.now(), audit = NO_AUDIT) {
  return update(guard, file, (db) => {
    const report = { consumed: 0, expired: 0, coldBench: 0, activeAfter: 0, archiveTrimmed: 0 };
    for (const s of activeSeeds(db)) {
      const ageMs = now - parseIso(s.bornAt);
      const sinceEvidence = parseIso(s.lastEvidenceAt);
      const sinceUsed = s.lastUsedAt ? parseIso(s.lastUsedAt) : 0;
      if (isConsumed(s, policy, sinceUsed, sinceEvidence)) {
        archiveSeed(s, "consumed", now);
        report.consumed += 1;
        emit(audit, { event: "seed_retired", id: s.id, reason: "consumed", via: "gc", used: s.used });
      } else if (now > parseIso(s.expiresAt)) {
        archiveSeed(s, "expired", now);
        report.expired += 1;
        emit(audit, { event: "seed_retired", id: s.id, reason: "expired", via: "gc", used: s.used });
      } else if (s.used === 0 && ageMs >= policy.seeds.coldBenchDays * DAY_MS) {
        archiveSeed(s, "cold_bench", now);
        report.coldBench += 1;
        emit(audit, { event: "seed_retired", id: s.id, reason: "cold_bench", via: "gc", used: s.used });
      }
    }
    const archived = db.seeds.filter((s) => s.status === "archived");
    if (archived.length > policy.seeds.archiveCap) {
      const drop = [...archived].sort((a, b) => parseIso(a.retiredAt ?? "") - parseIso(b.retiredAt ?? "")).slice(0, archived.length - policy.seeds.archiveCap);
      const dropped = new Set(drop.map((s) => s.id));
      db.seeds = db.seeds.filter((s) => !dropped.has(s.id));
      report.archiveTrimmed = drop.length;
      emit(audit, { event: "seed_archive_trimmed", count: drop.length, ids: drop.slice(0, 50).map((s) => s.id) });
    }
    report.activeAfter = activeSeeds(db).length;
    savePool(guard, file, db);
    return report;
  });
}
function surfaceSeed(guard, file, policy, id, now = Date.now(), audit = NO_AUDIT) {
  return update(guard, file, (db) => {
    const s = db.seeds.find((x) => x.id === id && x.status === "active");
    if (!s) return null;
    const prevUsedAt = s.lastUsedAt ? parseIso(s.lastUsedAt) : 0;
    s.used += 1;
    s.lastUsedAt = new Date(now).toISOString();
    if (isConsumed(s, policy, prevUsedAt, parseIso(s.lastEvidenceAt))) {
      archiveSeed(s, "consumed", now);
      emit(audit, { event: "seed_retired", id: s.id, reason: "consumed", via: "surface", used: s.used });
    }
    savePool(guard, file, db);
    return s;
  });
}
function archiveSeedById(guard, file, id, reason = "completed", now = Date.now(), audit = NO_AUDIT) {
  return update(guard, file, (db) => {
    const s = db.seeds.find((x) => x.id === id && x.status === "active");
    if (!s) return null;
    archiveSeed(s, reason, now);
    emit(audit, { event: "seed_retired", id: s.id, reason, via: "manual" });
    savePool(guard, file, db);
    return s;
  });
}
function restoreSeed(guard, file, policy, id, now = Date.now(), audit = NO_AUDIT) {
  return update(guard, file, (db) => {
    const s = db.seeds.find((x) => x.id === id && x.status === "archived");
    if (!s) return { ok: false, reason: "archived seed not found" };
    const category = normalizeCategory(s.category);
    const catCap = SEED_CATEGORY_CAPS[category];
    const inCategory = activeSeeds(db).filter((x) => normalizeCategory(x.category) === category).length;
    if (inCategory >= catCap) {
      return { ok: false, reason: `category full (${category}: ${catCap}); archive something in it first` };
    }
    if (activeSeeds(db).length >= policy.seeds.maxActive) {
      return { ok: false, reason: `pool full (${policy.seeds.maxActive}); archive something first` };
    }
    s.status = "active";
    s.retireReason = void 0;
    s.retiredAt = void 0;
    s.bornAt = new Date(now).toISOString();
    s.expiresAt = new Date(now + (policy.seeds.ttlDays[s.tag] || 14) * DAY_MS).toISOString();
    s.lastEvidenceAt = new Date(now).toISOString();
    emit(audit, { event: "seed_restored", id: s.id });
    savePool(guard, file, db);
    return { ok: true, seed: s };
  });
}
function deleteSeed(guard, file, id, audit = NO_AUDIT) {
  return update(guard, file, (db) => {
    const before = db.seeds.length;
    db.seeds = db.seeds.filter((x) => x.id !== id);
    if (db.seeds.length === before) return false;
    emit(audit, { event: "seed_deleted", id });
    savePool(guard, file, db);
    return true;
  });
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
//# sourceMappingURL=chunk-JDH2LDFS.js.map