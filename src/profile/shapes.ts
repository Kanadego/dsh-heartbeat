// Foreign-shape boundaries (review 2026-10-17 ⑧A). Every place that accepts
// data this code did not just build itself — the model's op array, journal
// lines, inbox lines, migration packages, RPC payloads — is checked against
// ONE schemastery definition here, instead of poking at properties ad hoc at
// each call site (HB-12: a malformed op used to reach the guards and throw
// somewhere in the middle of apply).
//
// schemastery objects are permissive on purpose: an absent field is simply
// absent (no error) and unknown keys ride through. Profile boundaries need the
// opposite, so closed() adds the two rules schemastery leaves out — required
// keys and a closed key set — and check() applies them before field types run.

import z from '@deepseek-ai/schemastery';
import {
  JOURNAL_VERSION,
  PARTITIONS,
  type Evidence,
  type EvidenceKind,
  type InboxItem,
  type JournalRecord,
  type Partition,
  type ProfileEntry,
  type ProfileOp,
  type Temporal,
} from './types.js';

export class ShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShapeError';
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v;
}

/** A required key. A nullable one accepts `null` as a real value (validTo /
 *  supersededBy) instead of reading it as absent. */
type Req = string | { key: string; nullable: true };

interface Closed {
  schema: Schemastery<any, any>;
  keys: readonly string[];
  required: readonly Req[];
}

function closed(
  schema: Schemastery<any, any>,
  keys: readonly string[],
  required: readonly Req[] = keys,
): Closed {
  return { schema, keys, required };
}

/** object-ness -> required keys -> closed key set -> schemastery field types. */
function check(shape: Closed, value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new ShapeError(`${label}: expected an object, got ${describe(value)}`);
  for (const req of shape.required) {
    const key = typeof req === 'string' ? req : req.key;
    const nullable = typeof req !== 'string' && req.nullable;
    if (value[key] === undefined || (value[key] === null && !nullable)) {
      throw new ShapeError(`${label}.${key}: missing required value`);
    }
  }
  for (const k of Object.keys(value)) {
    if (!shape.keys.includes(k)) throw new ShapeError(`${label}.${k}: unknown field`);
  }
  try {
    return shape.schema(value) as Record<string, unknown>;
  } catch (e) {
    throw new ShapeError(`${label}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const Str = z.string().required();
const Num = z.number().required();
// No .required() on this one: schemastery reads null as "absent", but null is
// a real value for validTo / supersededBy. check() enforces presence instead.
const NullableStr = z.union([z.string(), z.const(null)]);
const PartitionEnum = z.union(PARTITIONS.map((p) => z.const(p))).required();
const TemporalEnum = z.union([z.const('stable'), z.const('volatile')]).required();
/** Same set, optional: the model may omit temporal and take the schema default. */
const OptionalTemporal = z.union([z.const('stable'), z.const('volatile')]);
const KindEnum = z.union([
  z.const('chat'),
  z.const('screen'),
  z.const('browse'),
  z.const('hand'),
  z.const('ledger'),
]).required();
const ConfidenceNum = z.number().min(0).max(1).required();

// ── evidence ────────────────────────────────────────────────────────────────

const EvidenceShape = closed(
  z.object({ kind: KindEnum, at: Str, ref: Str, quote: z.string() }),
  ['kind', 'at', 'ref', 'quote'],
  ['kind', 'at', 'ref'],
);

export function parseEvidence(value: unknown, label = 'evidence'): Evidence {
  const o = check(EvidenceShape, value, label);
  return {
    kind: o.kind as EvidenceKind,
    at: String(o.at),
    ref: String(o.ref),
    ...(o.quote === undefined ? {} : { quote: String(o.quote) }),
  };
}

function parseEvidenceList(value: unknown, label: string): Evidence[] {
  if (!Array.isArray(value)) throw new ShapeError(`${label}: expected an array`);
  return value.map((v, i) => parseEvidence(v, `${label}[${i}]`));
}

// ── stored entry (journal v2 / migration packages) ──────────────────────────

const EntryShape = closed(
  z.object({
    id: Str,
    partition: PartitionEnum,
    topic: Str,
    subTopic: Str,
    content: Str,
    confidence: ConfidenceNum,
    temporal: TemporalEnum,
    validFrom: Str,
    validTo: NullableStr,
    supersededBy: NullableStr,
    evidence: z.array(z.any()).required(),
    createdAt: Str,
    updatedAt: Str,
    updateCount: Num,
    lowActivity: z.boolean(),
  }),
  ['id', 'partition', 'topic', 'subTopic', 'content', 'confidence', 'temporal', 'validFrom', 'validTo',
    'supersededBy', 'evidence', 'createdAt', 'updatedAt', 'updateCount', 'lowActivity'],
  ['id', 'partition', 'topic', 'subTopic', 'content', 'confidence', 'temporal', 'validFrom',
    { key: 'validTo', nullable: true }, { key: 'supersededBy', nullable: true },
    'evidence', 'createdAt', 'updatedAt', 'updateCount'],
);

export function parseProfileEntry(value: unknown, label = 'entry'): ProfileEntry {
  const o = check(EntryShape, value, label);
  return {
    id: String(o.id),
    partition: o.partition as Partition,
    topic: String(o.topic),
    subTopic: String(o.subTopic),
    content: String(o.content),
    confidence: Number(o.confidence),
    temporal: o.temporal as Temporal,
    validFrom: String(o.validFrom),
    validTo: o.validTo === null ? null : String(o.validTo),
    supersededBy: o.supersededBy === null ? null : String(o.supersededBy),
    evidence: parseEvidenceList(o.evidence, `${label}.evidence`),
    createdAt: String(o.createdAt),
    updatedAt: String(o.updatedAt),
    updateCount: Number(o.updateCount),
    ...(o.lowActivity === undefined ? {} : { lowActivity: Boolean(o.lowActivity) }),
  };
}

// ── inbox line ──────────────────────────────────────────────────────────────

const InboxShape = closed(
  z.object({ id: z.string(), kind: KindEnum, at: Str, ref: Str, note: z.string() }),
  ['id', 'kind', 'at', 'ref', 'note'],
  ['kind', 'at', 'ref'],
);

export function parseInboxItem(value: unknown, label = 'inbox item'): InboxItem {
  const o = check(InboxShape, value, label);
  return {
    ...(o.id === undefined ? {} : { id: String(o.id) }),
    kind: o.kind as EvidenceKind,
    at: String(o.at),
    ref: String(o.ref),
    note: o.note === undefined ? '' : String(o.note),
  };
}

// ── the model's op array (③A: ids in, evidence out) ─────────────────────────
//
// The model never supplies refs, timestamps or evidence kinds any more — it
// cites observation ids from THIS batch (o1, o2, …) and the caller turns them
// into Evidence objects. HB-05's forged provenance (a made-up "hand" ref used
// to pin confidence at 1.0) is unreachable by construction.

export type ProposedOp =
  | {
      op: 'ADD';
      partition: Partition;
      topic: string;
      subTopic: string;
      content: string;
      temporal?: Temporal;
      confidence?: number;
      why: string;
      evidenceRefs: string[];
    }
  | { op: 'UPDATE'; id: string; changes: { content?: string; confidence?: number }; why: string }
  | { op: 'INVALIDATE'; id: string; why: string; evidenceRefs: string[] }
  | { op: 'NOOP'; why: string };

const AddShape = closed(
  z.object({
    op: z.const('ADD').required(),
    partition: PartitionEnum,
    topic: Str,
    subTopic: Str,
    content: Str,
    temporal: OptionalTemporal,
    confidence: z.number().min(0).max(1),
    why: z.string(),
    evidence: z.array(z.any()).required(),
  }),
  ['op', 'partition', 'topic', 'subTopic', 'content', 'temporal', 'confidence', 'why', 'evidence'],
  ['op', 'partition', 'topic', 'subTopic', 'content', 'evidence'],
);

const UpdateShape = closed(
  z.object({
    op: z.const('UPDATE').required(),
    id: Str,
    changes: z.object({ content: z.string(), confidence: z.number().min(0).max(1) }),
    why: z.string(),
  }),
  ['op', 'id', 'changes', 'why'],
  ['op', 'id', 'changes'],
);

const InvalidateShape = closed(
  z.object({
    op: z.const('INVALIDATE').required(),
    id: Str,
    why: z.string(),
    evidence: z.array(z.any()),
  }),
  ['op', 'id', 'why', 'evidence'],
  ['op', 'id'],
);

const NoopShape = closed(
  z.object({ op: z.const('NOOP').required(), why: z.string() }),
  ['op', 'why'],
  ['op'],
);

function parseObservationRefs(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ShapeError(`${label}: expected an array of observation ids`);
  return value.map((v, i) => {
    if (typeof v !== 'string' || !v.trim()) {
      throw new ShapeError(`${label}[${i}]: expected an observation id like "o1" (refs, timestamps and kinds are code-generated)`);
    }
    return v.trim();
  });
}

function parseProposedOp(raw: unknown, label: string): ProposedOp {
  if (!isPlainObject(raw)) throw new ShapeError(`${label}: expected an object, got ${describe(raw)}`);
  const tag = raw.op;
  if (tag === 'ADD') {
    const o = check(AddShape, raw, label);
    const evidenceRefs = parseObservationRefs(o.evidence, `${label}.evidence`);
    if (evidenceRefs.length === 0) {
      throw new ShapeError(`${label}.evidence: ADD needs at least one observation id (axiom 1: no provenance, no memory)`);
    }
    return {
      op: 'ADD',
      partition: o.partition as Partition,
      topic: String(o.topic),
      subTopic: String(o.subTopic),
      content: String(o.content),
      ...(o.temporal === undefined ? {} : { temporal: o.temporal as Temporal }),
      ...(o.confidence === undefined ? {} : { confidence: Number(o.confidence) }),
      why: typeof o.why === 'string' ? o.why : '',
      evidenceRefs,
    };
  }
  if (tag === 'UPDATE') {
    const o = check(UpdateShape, raw, label);
    const changes = o.changes as Record<string, unknown>;
    const out: { content?: string; confidence?: number } = {};
    if (changes.content !== undefined) out.content = String(changes.content);
    if (changes.confidence !== undefined) out.confidence = Number(changes.confidence);
    if (out.content === undefined && out.confidence === undefined) {
      throw new ShapeError(`${label}.changes: needs content or confidence`);
    }
    return { op: 'UPDATE', id: String(o.id), changes: out, why: typeof o.why === 'string' ? o.why : '' };
  }
  if (tag === 'INVALIDATE') {
    const o = check(InvalidateShape, raw, label);
    return {
      op: 'INVALIDATE',
      id: String(o.id),
      why: typeof o.why === 'string' ? o.why : '',
      evidenceRefs: parseObservationRefs(o.evidence, `${label}.evidence`),
    };
  }
  if (tag === 'NOOP') {
    const o = check(NoopShape, raw, label);
    return { op: 'NOOP', why: typeof o.why === 'string' ? o.why : '' };
  }
  throw new ShapeError(`${label}.op: unknown op ${JSON.stringify(tag)}`);
}

export interface OpParseResult {
  ops: ProposedOp[];
  /** One malformed row never discards the rest of the batch, but it is always
   *  reported — silence here used to look like "the model proposed nothing". */
  rejected: { op: unknown; reason: string }[];
}

export function parseProposedOps(list: unknown[]): OpParseResult {
  const ops: ProposedOp[] = [];
  const rejected: { op: unknown; reason: string }[] = [];
  list.forEach((raw, i) => {
    try {
      ops.push(parseProposedOp(raw, `op[${i}]`));
    } catch (e) {
      rejected.push({ op: raw, reason: e instanceof Error ? e.message : String(e) });
    }
  });
  return { ops, rejected };
}

/** Turn cited observation ids into code-built evidence. Unknown ids are a
 *  rejection, never a silent drop: the op then has no provenance. */
export function materializeEvidence(
  refs: string[],
  observations: Map<string, InboxItem>,
  label: string,
): { evidence: Evidence[]; reason?: string } {
  const evidence: Evidence[] = [];
  for (const ref of refs) {
    const item = observations.get(ref);
    if (!item) return { evidence: [], reason: `${label}: ${ref} does not match any observation in this batch` };
    evidence.push({ kind: item.kind, at: item.at, ref: item.ref });
  }
  return { evidence };
}

// ── journal line reader (replay path) ───────────────────────────────────────
//
// Lenient on purpose: a line this code did not write is skipped by the caller,
// never fatal. The journal is append-only and immutable, so one bad line must
// not freeze the profile — but it IS counted (ReplayResult.badRecords) so a
// silent data loss is visible in profile verify.

export function tryParseJournalRecord(value: unknown): JournalRecord | null {
  try {
    if (!isPlainObject(value)) return null;
    const rec: JournalRecord = {
      ts: typeof value.ts === 'string' ? value.ts : '',
      runId: typeof value.runId === 'string' ? value.runId : '',
      applied: Array.isArray(value.applied) ? (value.applied as ProfileOp[]) : [],
      rejected: Array.isArray(value.rejected) ? (value.rejected as { op: unknown; reason: string }[]) : [],
    };
    if (value.v === JOURNAL_VERSION) {
      if (!Array.isArray(value.entries)) return null;
      rec.v = JOURNAL_VERSION;
      rec.entries = value.entries.map((e, i) => parseProfileEntry(e, `entries[${i}]`));
    }
    return rec;
  } catch {
    return null;
  }
}
