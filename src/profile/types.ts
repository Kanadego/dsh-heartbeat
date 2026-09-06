// User profile types (design doc §3). Fourth store: warm, structured,
// slow-evolving model of the user. Not the material pool (hot cache), not
// DSH long-term memory (conversation-validated layer).

export type Partition = 'interest' | 'projects' | 'comm' | 'psy';
export type Temporal = 'volatile' | 'stable';
export type EvidenceKind = 'chat' | 'screen' | 'browse' | 'hand' | 'ledger';

export interface Evidence {
  kind: EvidenceKind;
  at: string;
  /** Pointer to an existing audit/log location, e.g. "heartbeat.jsonl#2026-09-06T12:00:00Z". */
  ref: string;
  /** At most ONE short quote (<=1 sentence). Never raw conversation/screen text. */
  quote?: string;
}

export interface ProfileEntry {
  id: string;
  partition: Partition;
  topic: string;
  subTopic: string;
  content: string;
  /** 0..1; capped per source kind (chat .6 / screen .4 / browse .4). */
  confidence: number;
  temporal: Temporal;
  validFrom: string;
  validTo: string | null;
  supersededBy: string | null;
  evidence: Evidence[];
  createdAt: string;
  updatedAt: string;
  updateCount: number;
  /** stable-tier audit flag (180d without observation): digest deprioritizes. */
  lowActivity?: boolean;
}

export interface ProfileDoc {
  version: number;
  partitions: Record<Partition, { entries: ProfileEntry[] }>;
}

export interface InboxItem {
  id?: string;
  kind: EvidenceKind;
  at: string;
  ref: string;
  /** <= 1 short sentence; never raw conversation/screen text (truncated by writer). */
  note: string;
}

export type ProfileOp =
  | {
      op: 'ADD';
      partition: Partition;
      topic: string;
      subTopic: string;
      content: string;
      temporal?: Temporal;
      confidence?: number;
      why: string;
      evidence: Evidence[];
      /** Assigned by the store at apply time so journal replay preserves ids. */
      assignedId?: string;
    }
  | { op: 'UPDATE'; id: string; changes: { content?: string; confidence?: number }; why: string }
  | { op: 'INVALIDATE'; id: string; why: string; evidence?: Evidence[] }
  | { op: 'NOOP'; why: string };

export interface JournalRecord {
  ts: string;
  runId: string;
  applied: ProfileOp[];
  rejected: { op: ProfileOp; reason: string }[];
}

export interface ApplyReport {
  applied: ProfileOp[];
  rejected: { op: ProfileOp; reason: string }[];
}

export const PARTITIONS: readonly Partition[] = ['interest', 'projects', 'comm', 'psy'];

export const CONFIDENCE_CAP: Record<EvidenceKind, number> = {
  chat: 0.6,
  screen: 0.4,
  browse: 0.4,
  hand: 1.0,
  ledger: 0.6,
};

export function emptyProfile(): ProfileDoc {
  return {
    version: 1,
    partitions: { interest: { entries: [] }, projects: { entries: [] }, comm: { entries: [] }, psy: { entries: [] } },
  };
}
