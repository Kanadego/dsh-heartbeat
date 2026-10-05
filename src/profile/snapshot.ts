// Journal snapshot + shard rotation (v1.8.0, design doc §14 ③). The journal
// grows without bound; past the threshold the maintenance phase folds it into
// a DPAPI snapshot and moves the folded records into a timestamped archive
// shard, so replay cost stays bounded while the raw history survives on disk.
//
// Safety: replayJournal (store.ts) is the single authority reader and already
// understands snapshot → archives → live journal, so verify/rebuild keep
// working across rotations with no special-casing.

import fs from 'node:fs';
import path from 'node:path';
import { appendAuditLine } from '../core/audit-log.js';
import type { PathGuard } from '../core/path-guard.js';
import { saveJson } from '../vault/vault.js';
import {
  journalFilePath,
  replayJournal,
  snapshotFilePath,
  ARCHIVE_PREFIX,
  type ProfileSnapshot,
} from './store.js';

/** Fold the journal once the live file reaches this many records. */
export const SNAPSHOT_THRESHOLD = 5000;

export interface SnapshotReport {
  ok: boolean;
  reason?: string;
  baselineTs?: string;
  folded?: number;
  archiveFile?: string;
  liveRemaining?: number;
}

/** How far the live journal is from the snapshot threshold. */
export function snapshotDue(guard: PathGuard, dataDir: string, threshold = SNAPSHOT_THRESHOLD): { needed: boolean; lines: number } {
  let lines = 0;
  try {
    const raw = fs.readFileSync(guard.assert(journalFilePath(dataDir)), 'utf8');
    lines = raw.split('\n').filter((l) => l.trim()).length;
  } catch {
    return { needed: false, lines: 0 };
  }
  return { needed: lines >= threshold, lines };
}

/** Fold the live journal into a snapshot and shard the folded records into an
 * archive file. Returns a report; never throws on missing data (nothing to
 * fold is a no-op, reported as such). */
export function snapshotProfile(guard: PathGuard, dataDir: string, now = Date.now()): SnapshotReport {
  const journalFile = journalFilePath(dataDir);
  let raw = '';
  try {
    raw = fs.readFileSync(guard.assert(journalFile), 'utf8');
  } catch {
    return { ok: false, reason: 'no journal' };
  }
  const liveRecords = raw.split('\n').filter((l) => l.trim());
  if (liveRecords.length === 0) return { ok: false, reason: 'journal empty, nothing to fold' };

  // Replay the CURRENT live journal only — prior snapshots + shards are
  // already inside the accumulated view; the live tail is what we fold.
  const replayed = replayJournal(guard, dataDir);
  const lastTs = lastRecordTs(raw) ?? new Date(now).toISOString();
  const snapshot: ProfileSnapshot = {
    version: 1,
    baselineTs: lastTs,
    recordsFolded: replayed.records,
    doc: replayed.doc,
  };
  saveJson(guard, snapshotFilePath(dataDir), snapshot);

  // Shard: move the folded records out of the live journal. The shard is a
  // closed file (never appended again); the live journal restarts empty. A
  // torn shard write is tolerated by replay (corrupt lines are skipped).
  const stamp = new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const archiveFile = `${ARCHIVE_PREFIX}${stamp}.jsonl`;
  fs.writeFileSync(path.join(dataDir, archiveFile), liveRecords.join('\n') + '\n', 'utf8');
  fs.writeFileSync(guard.assert(journalFile), '', 'utf8');

  return {
    ok: true,
    baselineTs: lastTs,
    folded: replayed.records,
    archiveFile,
    liveRemaining: 0,
  };
}

function lastRecordTs(raw: string): string | null {
  const lines = raw.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return String((JSON.parse(lines[i]!) as { ts?: string }).ts ?? '') || null;
    } catch { /* skip a torn tail line */ }
  }
  return null;
}

/** Maintenance hook: fold when over threshold. Audits + never throws. */
export function snapshotIfDue(guard: PathGuard, dataDir: string, auditFile: string, why: string, now = Date.now()): void {
  try {
    const { needed, lines } = snapshotDue(guard, dataDir);
    if (!needed) return;
    const report = snapshotProfile(guard, dataDir, now);
    appendAuditLine(auditFile, { event: 'profile_snapshot', why, lines, ...report });
  } catch (e) {
    try {
      appendAuditLine(auditFile, { event: 'profile_snapshot_failed', why, error: String(e).slice(0, 160) });
    } catch { /* audit must never break the beat */ }
  }
}
