// Material pool engine (design doc §4). All four eviction rules are
// deterministic code - no LLM involvement (§4.2). Storage: data/seeds.jsonl,
// one seed per JSON line, DPAPI-encrypted at rest (D14).

import path from 'node:path';
import type { PathGuard } from '../core/path-guard.js';
import { loadEncryptedText, saveEncryptedText } from '../vault/vault.js';
import type { Policy } from '../config/schema.js';
import {
  SEED_SOURCE_DEFAULT_CONFIDENCE,
  emptySeedDb,
  type Seed,
  type SeedDb,
  type SeedRetireReason,
  type SeedSource,
  type SeedTag,
} from './types.js';

const DAY_MS = 86_400_000;

export interface AddSeedInput {
  text: string;
  topic?: string;
  tag?: SeedTag;
  source?: SeedSource;
  confidence?: number;
}

export interface AddSeedResult {
  kind: 'added' | 'merged' | 'duplicate';
  seed: Seed;
  evicted?: Seed;
}

export interface GcReport {
  consumed: number;
  expired: number;
  coldBench: number;
  activeAfter: number;
}

export const TTL_KEYS: readonly SeedTag[] = ['news', 'fandom', 'scene', 'promise'];

export function normalizeTag(tag: string | undefined): SeedTag {
  if (tag && (TTL_KEYS as readonly string[]).includes(tag)) return tag as SeedTag;
  return 'scene';
}

function parseIso(v: string): number {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

// ── storage ─────────────────────────────────────────────────────────────

export function seedsFilePath(dataDir: string): string {
  return path.join(dataDir, 'seeds.jsonl');
}

export function loadPool(guard: PathGuard, file: string): SeedDb {
  const raw = loadEncryptedText(guard, file);
  if (raw === null) return emptySeedDb();
  const db = emptySeedDb();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Seed;
      if (typeof obj.id === 'string' && obj.id.startsWith('s')) {
        db.seeds.push(obj);
        const n = Number(obj.id.slice(1));
        if (Number.isFinite(n) && n > db.seq) db.seq = n;
      }
    } catch {
      // corrupt line: skip (pool is a cache; journal-level audit lives elsewhere)
    }
  }
  return db;
}

export function savePool(guard: PathGuard, file: string, db: SeedDb): void {
  const body = db.seeds.map((s) => JSON.stringify(s)).join('\n');
  saveEncryptedText(guard, file, body ? body + '\n' : '');
}

// ── queries ─────────────────────────────────────────────────────────────

export const activeSeeds = (db: SeedDb): Seed[] => db.seeds.filter((s) => s.status === 'active');
export const archivedSeeds = (db: SeedDb): Seed[] => db.seeds.filter((s) => s.status === 'archived');

// ── eviction scoring (rule 4) ───────────────────────────────────────────

/**
 * Comprehensive score (§4.2): freshness x0.4 + unused x0.3 + confidence x0.3.
 * Higher = keep. Lowest-scoring active is evicted when the pool is full.
 */
export function evictionScore(seed: Seed, policy: Policy, now: number): number {
  const ttlDays = policy.seeds.ttlDays[seed.tag] || 14;
  const daysStale = Math.max(0, (now - parseIso(seed.lastEvidenceAt)) / DAY_MS);
  const freshness = Math.max(0, 1 - daysStale / ttlDays);
  const unused = seed.used === 0 ? 1 : 1 / seed.used;
  const w = policy.seeds.scoreWeights;
  return freshness * w.freshness + unused * w.unused + seed.confidence * w.confidence;
}

/** Pick the eviction victim: unprotected actives first (§4.2 加权保护). */
export function pickEvictionVictim(db: SeedDb, policy: Policy, now: number): Seed | null {
  const actives = activeSeeds(db);
  if (actives.length === 0) return null;
  const unprotected = actives.filter((s) => !s.protected);
  const candidates = unprotected.length > 0 ? unprotected : actives;
  let worst: Seed | null = null;
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

function archiveSeed(seed: Seed, reason: SeedRetireReason, now: number): void {
  seed.status = 'archived';
  seed.retireReason = reason;
  seed.retiredAt = new Date(now).toISOString();
}

// ── operations ──────────────────────────────────────────────────────────

export function addSeed(
  guard: PathGuard,
  file: string,
  policy: Policy,
  input: AddSeedInput,
  now = Date.now(),
): AddSeedResult {
  const db = loadPool(guard, file);
  const text = input.text.trim();
  if (!text) throw new Error('seed text must not be empty');
  const tag = normalizeTag(input.tag);
  const source: SeedSource = input.source ?? 'chat';
  const confidence = input.confidence ?? SEED_SOURCE_DEFAULT_CONFIDENCE[source];

  // Exact-text dedup against actives.
  const dup = activeSeeds(db).find((s) => s.text === text);
  if (dup) return { kind: 'duplicate', seed: dup };

  const nowIso = new Date(now).toISOString();
  const ttlMs = (policy.seeds.ttlDays[tag] || 14) * DAY_MS;

  // Same-topic merge (§4.3): collapse all same-topic actives + the new item.
  const sameTopic = activeSeeds(db).filter((s) => s.topic === (input.topic ?? text.slice(0, 24)));
  let seed: Seed;
  if (sameTopic.length > 0) {
    const kept = sameTopic[0]!;
    kept.text = text; // brief takes the latest
    kept.tag = tag;
    kept.source = source;
    kept.confidence = Math.max(kept.confidence, confidence);
    kept.used = sameTopic.reduce((acc, s) => acc + s.used, 0); // used accumulates
    kept.lastEvidenceAt = [kept.lastEvidenceAt, nowIso, ...sameTopic.map((s) => s.lastEvidenceAt)]
      .reduce((a, b) => (parseIso(b) > parseIso(a) ? b : a));
    kept.expiresAt = new Date(Math.max(parseIso(kept.expiresAt), now + ttlMs)).toISOString();
    kept.protected = kept.protected || source === 'hand' || (source === 'profile' && confidence >= 0.7);
    // remove the other same-topic actives (merged into kept)
    for (const extra of sameTopic.slice(1)) {
      extra.status = 'archived';
      extra.retireReason = 'completed';
      extra.retiredAt = nowIso;
    }
    seed = kept;
    // capacity still applies after growth check below if kept is somehow over cap
    if (activeSeeds(db).length > policy.seeds.maxActive) {
      const victim = pickEvictionVictim(db, policy, now);
      if (victim && victim.id !== kept.id) {
        archiveSeed(victim, 'pool_cap', now);
        savePool(guard, file, db);
        return { kind: 'merged', seed: kept, evicted: victim };
      }
    }
    savePool(guard, file, db);
    return { kind: 'merged', seed: kept };
  }

  // Capacity first (rule 4): evict before inserting when full.
  let evicted: Seed | undefined;
  if (activeSeeds(db).length >= policy.seeds.maxActive) {
    const victim = pickEvictionVictim(db, policy, now);
    if (victim) {
      archiveSeed(victim, 'pool_cap', now);
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
    protected: source === 'hand' || (source === 'profile' && confidence >= 0.7),
    used: 0,
    bornAt: nowIso,
    expiresAt: new Date(now + ttlMs).toISOString(),
    lastUsedAt: null,
    lastEvidenceAt: nowIso,
    status: 'active',
  };
  db.seeds.push(seed);
  savePool(guard, file, db);
  return { kind: 'added', seed, evicted };
}

/**
 * Deterministic gc (rules 1-3 of §4.2). Rule 4 (pool cap) fires on add only.
 */
export function gcPool(guard: PathGuard, file: string, policy: Policy, now = Date.now()): GcReport {
  const db = loadPool(guard, file);
  const report: GcReport = { consumed: 0, expired: 0, coldBench: 0, activeAfter: 0 };
  for (const s of activeSeeds(db)) {
    const ageMs = now - parseIso(s.bornAt);
    const sinceEvidence = parseIso(s.lastEvidenceAt);
    const sinceUsed = s.lastUsedAt ? parseIso(s.lastUsedAt) : 0;
    if (s.used >= policy.seeds.retireAfterUsed && sinceEvidence <= sinceUsed) {
      archiveSeed(s, 'consumed', now);
      report.consumed += 1;
    } else if (now > parseIso(s.expiresAt)) {
      archiveSeed(s, 'expired', now);
      report.expired += 1;
    } else if (s.used === 0 && ageMs >= policy.seeds.coldBenchDays * DAY_MS) {
      archiveSeed(s, 'cold_bench', now);
      report.coldBench += 1;
    }
  }
  report.activeAfter = activeSeeds(db).length;
  savePool(guard, file, db);
  return report;
}

/** The seed surfaced in a real expression: count + maybe retire (rule 1). */
export function surfaceSeed(
  guard: PathGuard,
  file: string,
  policy: Policy,
  id: string,
  now = Date.now(),
): Seed | null {
  const db = loadPool(guard, file);
  const s = db.seeds.find((x) => x.id === id && x.status === 'active');
  if (!s) return null;
  s.used += 1;
  s.lastUsedAt = new Date(now).toISOString();
  if (s.used >= policy.seeds.retireAfterUsed && parseIso(s.lastEvidenceAt) <= parseIso(s.lastUsedAt)) {
    archiveSeed(s, 'consumed', now);
  }
  savePool(guard, file, db);
  return s;
}

/** Deliberate retirement (item completed / no longer relevant). */
export function archiveSeedById(
  guard: PathGuard,
  file: string,
  id: string,
  reason: SeedRetireReason = 'completed',
  now = Date.now(),
): Seed | null {
  const db = loadPool(guard, file);
  const s = db.seeds.find((x) => x.id === id && x.status === 'active');
  if (!s) return null;
  archiveSeed(s, reason, now);
  savePool(guard, file, db);
  return s;
}
