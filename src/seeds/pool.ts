// Material pool engine (design doc §4). All four eviction rules are
// deterministic code - no LLM involvement (§4.2). Storage: data/seeds.jsonl,
// one seed per JSON line, DPAPI-encrypted at rest (D14).

import path from 'node:path';
import type { PathGuard } from '../core/path-guard.js';
import { loadEncryptedText, saveEncryptedText } from '../vault/vault.js';
import { withFileLock } from '../core/file-lock.js';
import type { Policy } from '../config/schema.js';
import {
  SEED_SOURCE_DEFAULT_CONFIDENCE,
  emptySeedDb,
  type Seed,
  type SeedCategory,
  type SeedDb,
  type SeedRetireReason,
  type SeedSource,
  type SeedTag,
} from './types.js';

const DAY_MS = 86_400_000;

// ── lifecycle audit (2026-10-06 / v1.9.0) ───────────────────────────────
// The pool used to mutate in silence: a seed could appear, be evicted for
// capacity, or be dropped from the archive with nothing in the log. Every
// mutator now takes an optional sink and reports what it did. IDs and
// metadata ONLY — heartbeat.jsonl is plaintext by charter and must never
// carry conversation text; the seed text itself stays in the DPAPI pool.
export type SeedAuditFn = (entry: Record<string, unknown>) => void;

const NO_AUDIT: SeedAuditFn = () => {};

/** Audit must never break the pool (or the beat that called it). */
function emit(audit: SeedAuditFn, entry: Record<string, unknown>): void {
  try {
    audit(entry);
  } catch {
    /* audit is diagnostic; a failed append is not a pool failure */
  }
}

// Per-category pool caps (2026-09-18 spec ⑤): topic stock vs conversation-grown
// chat material, decoupled from `source`; sum == the global maxActive default.
export const SEED_CATEGORY_CAPS: Record<SeedCategory, number> = { topic: 16, chat: 14 };

const CATEGORY_VALUES: readonly string[] = ['topic', 'chat'];

/** Lenient category coercion for on-disk rows: anything missing/unknown (all
 *  pre-v1.5 seeds) counts as topic stock. */
export function normalizeCategory(v: unknown): SeedCategory {
  return typeof v === 'string' && (CATEGORY_VALUES as readonly string[]).includes(v)
    ? (v as SeedCategory)
    : 'topic';
}

export interface AddSeedInput {
  text: string;
  topic?: string;
  tag?: SeedTag;
  source?: SeedSource;
  /** Loop role (spec ⑤); defaults from source: chat->chat, everything else->topic. */
  category?: SeedCategory;
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
  /** v1.9.0: archived rows dropped to honor seeds.archiveCap (oldest first). */
  archiveTrimmed: number;
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
        // spec ⑤ loadPool tolerance: only the id is load-bearing; a missing or
        // unknown category (every pre-v1.5 row) falls back to topic stock.
        obj.category = normalizeCategory(obj.category);
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

/**
 * H-20 (minimal tier): every pool writer goes through here, so the load happens
 * INSIDE the cross-process lock and cannot be based on a read that went stale
 * while it was being mutated — the CLI is a second process sharing this file,
 * and an interleaved write used to be silently overwritten. The ciphertext is a
 * whole-file rewrite, so append/merge does not apply here; the append-only pool
 * with compaction is v2.0 work (ledger #8649f9).
 */
function update<T>(guard: PathGuard, file: string, fn: (db: SeedDb) => T): T {
  return withFileLock(file, () => fn(loadPool(guard, file)));
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

/** Pick the eviction victim: unprotected actives first (§4.2 加权保护); with
 *  `category`, only that category's actives compete (spec ⑤ per-category caps). */
export function pickEvictionVictim(db: SeedDb, policy: Policy, now: number, category?: SeedCategory): Seed | null {
  const actives = activeSeeds(db).filter((s) => category === undefined || normalizeCategory(s.category) === category);
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

/** Spec ④: chat-grown material is consumed ONCE (conversation freshness);
 *  every other category follows the policy-wide retireAfterUsed. */
function retireLimit(s: Seed, policy: Policy): number {
  return normalizeCategory(s.category) === 'chat' ? 1 : policy.seeds.retireAfterUsed;
}

/**
 * Rule 1 (§4.2): used up to its limit AND no evidence newer than the PREVIOUS
 * use. `prevUsedAt` MUST be read before bumping `lastUsedAt` — comparing the
 * just-written value against `lastEvidenceAt` is vacuously true (H-22), which
 * retired seeds that had received fresh evidence in the same beat. Both
 * callers (gc and surface) share this, so the rule cannot drift again.
 *
 * `prevUsedAt === 0` means "never used before": there is no earlier use for
 * the evidence to be newer THAN, so the exemption cannot apply — a one-shot
 * (chat) seed still retires on its first surfacing (spec ④), which is the
 * contract, not a regression.
 */
function isConsumed(s: Seed, policy: Policy, prevUsedAt: number, sinceEvidence: number): boolean {
  if (s.used < retireLimit(s, policy)) return false;
  return !(prevUsedAt > 0 && sinceEvidence > prevUsedAt);
}

// ── operations ──────────────────────────────────────────────────────────

export function addSeed(
  guard: PathGuard,
  file: string,
  policy: Policy,
  input: AddSeedInput,
  now = Date.now(),
  audit: SeedAuditFn = NO_AUDIT,
): AddSeedResult {
  // H-20: the read-modify-write below runs under the cross-process pool lock
  // (same guard as `update`, kept as a named body to avoid re-indenting it).
  return withFileLock(file, () => addSeedLocked(guard, file, policy, input, now, audit));
}

function addSeedLocked(
  guard: PathGuard,
  file: string,
  policy: Policy,
  input: AddSeedInput,
  now: number,
  audit: SeedAuditFn,
): AddSeedResult {
  const db = loadPool(guard, file);
  const text = input.text.trim();
  if (!text) throw new Error('seed text must not be empty');
  const tag = normalizeTag(input.tag);
  const source: SeedSource = input.source ?? 'chat';
  const category = normalizeCategory(input.category ?? (source === 'chat' ? 'chat' : 'topic'));
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
    kept.category = normalizeCategory(input.category ?? kept.category ?? category);
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
      emit(audit, { event: 'seed_retired', id: extra.id, reason: 'completed', via: 'merge', into: kept.id });
    }
    seed = kept;
    // capacity still applies after growth check below if kept is somehow over cap
    if (activeSeeds(db).length > policy.seeds.maxActive) {
      const victim = pickEvictionVictim(db, policy, now, normalizeCategory(kept.category));
      if (victim && victim.id !== kept.id) {
        archiveSeed(victim, 'pool_cap', now);
        emit(audit, { event: 'seed_added', id: kept.id, kind: 'merged', tag: kept.tag, source: kept.source, category: kept.category, confidence: kept.confidence, mergedFrom: sameTopic.length - 1 });
        emit(audit, { event: 'seed_retired', id: victim.id, reason: 'pool_cap', via: 'merge', into: kept.id });
        savePool(guard, file, db);
        return { kind: 'merged', seed: kept, evicted: victim };
      }
    }
    emit(audit, { event: 'seed_added', id: kept.id, kind: 'merged', tag: kept.tag, source: kept.source, category: kept.category, confidence: kept.confidence, mergedFrom: sameTopic.length - 1 });
    savePool(guard, file, db);
    return { kind: 'merged', seed: kept };
  }

  // Capacity first (rules 4 + spec ⑤): per-category cap evicts within its own
  // pool; the global cap evicts in the incoming seed's category (a full topic
  // stock must not push chat material out and vice versa).
  let evicted: Seed | undefined;
  const catCount = activeSeeds(db).filter((s) => normalizeCategory(s.category) === category).length;
  if (catCount >= SEED_CATEGORY_CAPS[category]) {
    const victim = pickEvictionVictim(db, policy, now, category);
    if (victim) {
      archiveSeed(victim, 'pool_cap', now);
      evicted = victim;
    }
  }
  if (activeSeeds(db).length >= policy.seeds.maxActive) {
    const victim = pickEvictionVictim(db, policy, now, category);
    if (victim) {
      archiveSeed(victim, 'pool_cap', now);
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
    protected: source === 'hand' || (source === 'profile' && confidence >= 0.7),
    used: 0,
    bornAt: nowIso,
    expiresAt: new Date(now + ttlMs).toISOString(),
    lastUsedAt: null,
    lastEvidenceAt: nowIso,
    status: 'active',
  };
  db.seeds.push(seed);
  emit(audit, { event: 'seed_added', id: seed.id, kind: 'added', tag: seed.tag, source: seed.source, category: seed.category, confidence: seed.confidence });
  if (evicted) emit(audit, { event: 'seed_retired', id: evicted.id, reason: 'pool_cap', via: 'add', into: seed.id });
  savePool(guard, file, db);
  return { kind: 'added', seed, evicted };
}

/**
 * Deterministic gc (rules 1-3 of §4.2). Rule 4 (pool cap) fires on add only.
 * v1.9.0: the archive area is ALSO capped (seeds.archiveCap) — the archive is
 * a forensic trail, not a hoard; trim oldest-retired first.
 */
export function gcPool(guard: PathGuard, file: string, policy: Policy, now = Date.now(), audit: SeedAuditFn = NO_AUDIT): GcReport {
  return update(guard, file, (db) => {
  const report: GcReport = { consumed: 0, expired: 0, coldBench: 0, activeAfter: 0, archiveTrimmed: 0 };
  for (const s of activeSeeds(db)) {
    const ageMs = now - parseIso(s.bornAt);
    const sinceEvidence = parseIso(s.lastEvidenceAt);
    const sinceUsed = s.lastUsedAt ? parseIso(s.lastUsedAt) : 0;
    if (isConsumed(s, policy, sinceUsed, sinceEvidence)) {
      archiveSeed(s, 'consumed', now);
      report.consumed += 1;
      emit(audit, { event: 'seed_retired', id: s.id, reason: 'consumed', via: 'gc', used: s.used });
    } else if (now > parseIso(s.expiresAt)) {
      archiveSeed(s, 'expired', now);
      report.expired += 1;
      emit(audit, { event: 'seed_retired', id: s.id, reason: 'expired', via: 'gc', used: s.used });
    } else if (s.used === 0 && ageMs >= policy.seeds.coldBenchDays * DAY_MS) {
      archiveSeed(s, 'cold_bench', now);
      report.coldBench += 1;
      emit(audit, { event: 'seed_retired', id: s.id, reason: 'cold_bench', via: 'gc', used: s.used });
    }
  }
  // archive cap: drop the oldest-retired rows beyond the cap (retiredAt may be
  // missing on pre-v1.5 rows — parseIso('') = 0 sorts them oldest).
  const archived = db.seeds.filter((s) => s.status === 'archived');
  if (archived.length > policy.seeds.archiveCap) {
    const drop = [...archived]
      .sort((a, b) => parseIso(a.retiredAt ?? '') - parseIso(b.retiredAt ?? ''))
      .slice(0, archived.length - policy.seeds.archiveCap);
    const dropped = new Set(drop.map((s) => s.id));
    db.seeds = db.seeds.filter((s) => !dropped.has(s.id));
    report.archiveTrimmed = drop.length;
    // These rows are GONE (not archived — deleted): the log is the only trace
    // left, so name them. IDs only, and cap the list in case a first GC trims
    // a legacy archive wholesale.
    emit(audit, { event: 'seed_archive_trimmed', count: drop.length, ids: drop.slice(0, 50).map((s) => s.id) });
  }
  report.activeAfter = activeSeeds(db).length;
  savePool(guard, file, db);
  return report;
  });
}

/** The seed surfaced in a real expression: count + maybe retire (rule 1). */
export function surfaceSeed(
  guard: PathGuard,
  file: string,
  policy: Policy,
  id: string,
  now = Date.now(),
  audit: SeedAuditFn = NO_AUDIT,
): Seed | null {
  return update(guard, file, (db) => {
    const s = db.seeds.find((x) => x.id === id && x.status === 'active');
    if (!s) return null;
    // H-22: snapshot the PREVIOUS use time before bumping it — the retirement
    // check must compare against the last use, not against this one.
    const prevUsedAt = s.lastUsedAt ? parseIso(s.lastUsedAt) : 0;
    s.used += 1;
    s.lastUsedAt = new Date(now).toISOString();
    if (isConsumed(s, policy, prevUsedAt, parseIso(s.lastEvidenceAt))) {
      archiveSeed(s, 'consumed', now);
      emit(audit, { event: 'seed_retired', id: s.id, reason: 'consumed', via: 'surface', used: s.used });
    }
    savePool(guard, file, db);
    return s;
  });
}

/** Deliberate retirement (item completed / no longer relevant). */
export function archiveSeedById(
  guard: PathGuard,
  file: string,
  id: string,
  reason: SeedRetireReason = 'completed',
  now = Date.now(),
  audit: SeedAuditFn = NO_AUDIT,
): Seed | null {
  return update(guard, file, (db) => {
    const s = db.seeds.find((x) => x.id === id && x.status === 'active');
    if (!s) return null;
    archiveSeed(s, reason, now);
    emit(audit, { event: 'seed_retired', id: s.id, reason, via: 'manual' });
    savePool(guard, file, db);
    return s;
  });
}

/** Restore an archived seed to the active pool (UI operation; resets TTL). */
export function restoreSeed(
  guard: PathGuard,
  file: string,
  policy: Policy,
  id: string,
  now = Date.now(),
  audit: SeedAuditFn = NO_AUDIT,
): { ok: true; seed: Seed } | { ok: false; reason: string } {
  return update<{ ok: true; seed: Seed } | { ok: false; reason: string }>(guard, file, (db) => {
  const s = db.seeds.find((x) => x.id === id && x.status === 'archived');
  if (!s) return { ok: false, reason: 'archived seed not found' };
  // H-23: a restore must satisfy the same two caps an add does — the global
  // one AND the per-category one. The add path evicts a neighbour instead, but
  // restoring a memory is a user action: refuse it rather than silently
  // pushing someone else's material out.
  const category = normalizeCategory(s.category);
  const catCap = SEED_CATEGORY_CAPS[category];
  const inCategory = activeSeeds(db).filter((x) => normalizeCategory(x.category) === category).length;
  if (inCategory >= catCap) {
    return { ok: false, reason: `category full (${category}: ${catCap}); archive something in it first` };
  }
  if (activeSeeds(db).length >= policy.seeds.maxActive) {
    return { ok: false, reason: `pool full (${policy.seeds.maxActive}); archive something first` };
  }
  s.status = 'active';
  s.retireReason = undefined;
  s.retiredAt = undefined;
  // H-23: reset bornAt as well — cold-bench eviction (used === 0 && age >=
  // coldBenchDays) keys off bornAt, so a restored seed used to be re-archived
  // by the very next maintenance beat ("restored, then gone one beat later").
  s.bornAt = new Date(now).toISOString();
  s.expiresAt = new Date(now + (policy.seeds.ttlDays[s.tag] || 14) * DAY_MS).toISOString();
  s.lastEvidenceAt = new Date(now).toISOString();
  emit(audit, { event: 'seed_restored', id: s.id });
  savePool(guard, file, db);
  return { ok: true, seed: s };
  });
}

/** Hard delete (UI explicit action with confirm; the caller audits it). */
export function deleteSeed(guard: PathGuard, file: string, id: string, audit: SeedAuditFn = NO_AUDIT): boolean {
  return update(guard, file, (db) => {
    const before = db.seeds.length;
    db.seeds = db.seeds.filter((x) => x.id !== id);
    if (db.seeds.length === before) return false;
    emit(audit, { event: 'seed_deleted', id });
    savePool(guard, file, db);
    return true;
  });
}
