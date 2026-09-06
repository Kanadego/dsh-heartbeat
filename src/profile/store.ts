// Profile store: materialized view + journal (the journal is the ONLY
// authority; profile.json is a pure projection - r2 §14 verify/rebuild).
// Every LLM-proposed op passes deterministic guards here (LLM nominates,
// code decides - §3.3).

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { PathGuard } from '../core/path-guard.js';
import { loadJson, saveJson, readText, writeText } from '../vault/vault.js';
import { atomicWriteFileSync } from '../core/atomic-fs.js';
import type { Policy } from '../config/schema.js';
import {
  CONFIDENCE_CAP,
  emptyProfile,
  PARTITIONS,
  type ApplyReport,
  type Evidence,
  type EvidenceKind,
  type InboxItem,
  type JournalRecord,
  type Partition,
  type ProfileDoc,
  type ProfileEntry,
  type ProfileOp,
} from './types.js';
import { checkAddAgainstSchema, type ProfileSchema } from './schema.js';

const DAY_MS = 86_400_000;

export function profileFilePath(dataDir: string): string {
  return path.join(dataDir, 'profile.json');
}

export function journalFilePath(dataDir: string): string {
  return path.join(dataDir, 'profile_journal.jsonl');
}

export function loadProfile(guard: PathGuard, file: string): ProfileDoc {
  const doc = loadJson<ProfileDoc>(guard, file);
  if (!doc || !doc.partitions) return emptyProfile();
  // ensure all partitions exist
  for (const p of PARTITIONS) {
    if (!doc.partitions[p]) doc.partitions[p] = { entries: [] };
  }
  return doc;
}

function parseIso(v: string): number {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

/** ref format "<datafile>#<locator>": the referenced file must exist under data/. */
function refExists(guard: PathGuard, dataDir: string, ref: string): boolean {
  const base = ref.split('#')[0] ?? '';
  if (!base) return false;
  const target = path.join(dataDir, base);
  try {
    return fs.existsSync(guard.assert(target));
  } catch {
    return false;
  }
}

function capForKinds(kinds: EvidenceKind[]): number {
  if (kinds.length === 0) return 0.4;
  return Math.min(...kinds.map((k) => CONFIDENCE_CAP[k] ?? 0.4));
}

function findActive(doc: ProfileDoc, id: string): ProfileEntry | undefined {
  for (const p of PARTITIONS) {
    const hit = doc.partitions[p]!.entries.find((e) => e.id === id && e.validTo === null);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Apply validated ops to the doc (mutates). Returns applied/rejected.
 * Guards (§3.3): whitelist, evidence gate, per-run ops cap is enforced by the
 * caller, confidence caps by evidence kind, psy gating, INVALIDATE ownership:
 * volatile expiry is code-driven (LLM may not), stable invalidation needs a
 * contradicting observation attached.
 */
export function applyOpsToDoc(
  guard: PathGuard,
  dataDir: string,
  doc: ProfileDoc,
  ops: ProfileOp[],
  schema: ProfileSchema,
  policy: Policy,
  now: number,
): ApplyReport {
  const applied: ProfileOp[] = [];
  const rejected: { op: ProfileOp; reason: string }[] = [];
  const nowIso = new Date(now).toISOString();

  for (const op of ops) {
    if (op.op === 'NOOP') {
      applied.push(op);
      continue;
    }
    if (op.op === 'ADD') {
      if (op.partition === 'psy' && !policy.profile.psyEnabled) {
        rejected.push({ op, reason: 'psy partition is disabled' });
        continue;
      }
      const check = checkAddAgainstSchema(schema, op.partition, op.topic, op.subTopic, op.temporal);
      if (!check.ok) {
        rejected.push({ op, reason: check.reason! });
        continue;
      }
      if (!op.evidence || op.evidence.length === 0) {
        rejected.push({ op, reason: 'ADD without evidence (no provenance, axiom 1)' });
        continue;
      }
      const badRef = op.evidence.find((e) => !refExists(guard, dataDir, e.ref));
      if (badRef) {
        rejected.push({ op, reason: `evidence ref does not resolve: ${badRef.ref}` });
        continue;
      }
      const cap = capForKinds(op.evidence.map((e) => e.kind));
      const active = doc.partitions[op.partition]!.entries.filter((e) => e.validTo === null);
      if (active.length >= policy.profile.partitionCap) {
        rejected.push({ op, reason: `partition ${op.partition} at cap (${policy.profile.partitionCap}); converge first` });
        continue;
      }
      dbSeq += 1;
      const entry: ProfileEntry = {
        id: `p${dbSeq.toString(36)}${randomUUID().slice(0, 4)}`,
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
        updateCount: 0,
      };
      op.assignedId = entry.id; // journal replay must reproduce this id
      doc.partitions[op.partition]!.entries.push(entry);
      applied.push(op);
      continue;
    }
    if (op.op === 'UPDATE') {
      const entry = findActive(doc, op.id);
      if (!entry) {
        rejected.push({ op, reason: `unknown or inactive entry: ${op.id}` });
        continue;
      }
      if (op.changes.content !== undefined) entry.content = op.changes.content.trim();
      if (op.changes.confidence !== undefined) {
        const cap = capForKinds(entry.evidence.map((e) => e.kind));
        // confidence upgrades need a second confirming observation (§3.3):
        // only allowed up to cap, and only when the entry already has 2+ evidence
        if (op.changes.confidence > entry.confidence && entry.evidence.length < 2) {
          rejected.push({ op, reason: 'confidence upgrade requires a second confirming observation' });
          continue;
        }
        entry.confidence = Math.min(op.changes.confidence, cap);
      }
      entry.updatedAt = nowIso;
      entry.updateCount += 1;
      applied.push(op);
      continue;
    }
    if (op.op === 'INVALIDATE') {
      const entry = findActive(doc, op.id);
      if (!entry) {
        rejected.push({ op, reason: `unknown or inactive entry: ${op.id}` });
        continue;
      }
      if (entry.temporal === 'volatile') {
        rejected.push({ op, reason: 'volatile expiry is code-owned (time-driven), not LLM-nominated' });
        continue;
      }
      // stable: rebuttal-driven; requires a contradicting observation attached
      const hasNewObservation = (op.evidence ?? []).length > 0
        && (op.evidence ?? []).some((e) => parseIso(e.at) > parseIso(entry.evidence[entry.evidence.length - 1]?.at ?? ''));
      if (!hasNewObservation) {
        rejected.push({ op, reason: 'stable INVALIDATE requires a newer contradicting observation' });
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

let dbSeq = 0;

/** Deterministic aging (D9): volatile expiry + stable low-activity marking. */
export function runDeterministicAging(
  doc: ProfileDoc,
  policy: Policy,
  now: number,
): { volatileExpired: number; lowActivityMarked: number } {
  const nowIso = new Date(now).toISOString();
  let volatileExpired = 0;
  let lowActivityMarked = 0;
  for (const p of PARTITIONS) {
    for (const e of doc.partitions[p]!.entries) {
      if (e.validTo !== null) continue;
      const lastEvidence = Math.max(...e.evidence.map((x) => parseIso(x.at)), parseIso(e.updatedAt));
      if (e.temporal === 'volatile') {
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

/** Persist the materialized view atomically + append the journal record. */
export function persistWithJournal(
  guard: PathGuard,
  dataDir: string,
  doc: ProfileDoc,
  record: Omit<JournalRecord, 'ts'>,
): void {
  saveJson(guard, profileFilePath(dataDir), doc);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
  const journal = journalFilePath(dataDir);
  try {
    fs.appendFileSync(guard.assert(journal), line + '\n', 'utf8');
  } catch {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(guard.assert(journal), line + '\n', 'utf8');
  }
}

// ── journal replay (verify / rebuild, r2 §14) ───────────────────────────

function applyOpPermissive(doc: ProfileDoc, op: ProfileOp, ts: string): void {
  // Journal is trusted history: replay applies without revalidation.
  if (op.op === 'ADD') {
    dbSeq += 1;
    doc.partitions[op.partition]!.entries.push({
      id: op.assignedId ?? `r${dbSeq.toString(36)}${randomUUID().slice(0, 4)}`,
      partition: op.partition,
      topic: op.topic,
      subTopic: op.subTopic,
      content: op.content,
      confidence: op.confidence ?? 0.5,
      temporal: op.temporal ?? 'stable',
      validFrom: ts,
      validTo: null,
      supersededBy: null,
      evidence: op.evidence,
      createdAt: ts,
      updatedAt: ts,
      updateCount: 0,
    });
    return;
  }
  if (op.op === 'UPDATE') {
    const e = [...PARTITIONS].flatMap((p) => doc.partitions[p]!.entries).find((x) => x.id === op.id);
    if (e) {
      if (op.changes.content !== undefined) e.content = op.changes.content;
      if (op.changes.confidence !== undefined) e.confidence = op.changes.confidence;
      e.updatedAt = ts;
      e.updateCount += 1;
    }
    return;
  }
  if (op.op === 'INVALIDATE') {
    const e = [...PARTITIONS].flatMap((p) => doc.partitions[p]!.entries).find((x) => x.id === op.id);
    if (e) {
      e.validTo = ts;
      e.updatedAt = ts;
      e.updateCount += 1;
    }
  }
  // NOOP: nothing
}

export interface ReplayResult {
  doc: ProfileDoc;
  truncatedTail: number;
  records: number;
}

/** Full replay from an empty view. Tolerates a torn tail (explicitly). */
export function replayJournal(guard: PathGuard, dataDir: string): ReplayResult {
  const journal = journalFilePath(dataDir);
  const raw = readText(guard, journal, '');
  const doc = emptyProfile();
  let records = 0;
  let truncatedTail = 0;
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as JournalRecord;
      for (const op of rec.applied ?? []) applyOpPermissive(doc, op, rec.ts);
      records += 1;
    } catch {
      const isLast = lines.slice(i + 1).every((l) => !l.trim());
      if (isLast) {
        truncatedTail = lines.length - i; // torn tail from a mid-write crash
        break;
      }
      // mid-file corrupt record: skip (journal stays append-only/immutable)
    }
  }
  return { doc, truncatedTail, records };
}

export interface VerifyReport {
  ok: boolean;
  firstDivergence?: { id: string; expected: string; actual: string };
  truncatedTail: number;
  records: number;
}

/** profile verify: replay vs disk, report first divergence, never fix. */
export function verifyProfile(guard: PathGuard, dataDir: string): VerifyReport {
  const replayed = replayJournal(guard, dataDir);
  const onDisk = loadProfile(guard, profileFilePath(dataDir));
  // Timestamps legitimately differ (journal record ts >= op ts); identity
  // fields are also normalized. Compare semantic content only.
  const strip = (doc: ProfileDoc): string =>
    JSON.stringify(doc.partitions, (k, v) => (['id', 'supersededBy', 'validFrom', 'createdAt', 'updatedAt', 'retiredAt'].includes(k) ? '<norm>' : v));
  const ok = strip(replayed.doc) === strip(onDisk);
  if (ok) return { ok: true, truncatedTail: replayed.truncatedTail, records: replayed.records };
  // first divergence: first entry id present in only one view
  const diskIds = new Set([...PARTITIONS].flatMap((p) => onDisk.partitions[p]!.entries.map((e) => e.content)));  const replayIds = new Set([...PARTITIONS].flatMap((p) => replayed.doc.partitions[p]!.entries.map((e) => e.content)));
  const onlyDisk = [...diskIds].find((c) => !replayIds.has(c));
  const onlyReplay = [...replayIds].find((c) => !diskIds.has(c));
  return {
    ok: false,
    firstDivergence: {
      id: onlyDisk ?? onlyReplay ?? '(content)',
      expected: onlyReplay ? 'absent in journal replay' : 'present in journal replay',
      actual: onlyDisk ? 'present on disk' : 'absent on disk',
    },
    truncatedTail: replayed.truncatedTail,
    records: replayed.records,
  };
}

export interface RebuildReport {
  ok: boolean;
  truncatedTail: number;
  records: number;
  wrote: boolean;
}

/** profile rebuild: journal is authoritative; atomic replace; torn tail reported. */
export function rebuildProfile(
  guard: PathGuard,
  dataDir: string,
  opts: { check?: boolean } = {},
): RebuildReport & { diffSummary?: string } {
  const replayed = replayJournal(guard, dataDir);
  const target = profileFilePath(dataDir);
  const tmp = path.join(dataDir, `.profile.rebuild.${Date.now()}.tmp`);
  atomicWriteFileSync(tmp, JSON.stringify(replayed.doc, null, 2));
  if (opts.check) {
    const onDisk = loadProfile(guard, target);
    const same = JSON.stringify(onDisk) === JSON.stringify(replayed.doc);
    fs.rmSync(tmp, { force: true });
    return {
      ok: same,
      truncatedTail: replayed.truncatedTail,
      records: replayed.records,
      wrote: false,
      diffSummary: same ? 'no diff' : 'materialized view differs from journal replay',
    };
  }
  fs.renameSync(tmp, target);
  if (replayed.truncatedTail > 0) {
    // explicit audit: never silently rebuild a view that lost its tail
    writeText(
      guard,
      path.join(dataDir, 'logs', 'rebuild-report.txt'),
      `rebuild truncated ${replayed.truncatedTail} torn line(s) at journal tail; ${replayed.records} records applied\n`,
    );
  }
  return { ok: true, truncatedTail: replayed.truncatedTail, records: replayed.records, wrote: true };
}
