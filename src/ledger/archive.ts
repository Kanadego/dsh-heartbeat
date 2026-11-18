// One-time archive migration (2.3.0 P0-2). Before live-only books existed,
// done rows stayed inline in `ledger.md` (and, on the old corrections branch,
// `corrections.md`). This module moves the rows still sitting there into the
// matching `*-done.md` archive ONCE:
//
//   · back up the book first (`<book>.md.bak-<timestamp>`),
//   · append the done rows to the archive (verbatim, same line format),
//   · rewrite the book without them,
//   · record `<marker> = true` in data/settings/state.json and audit the count.
//
// Reentrancy: the marker makes a second start a no-op; the marker is re-read
// under the book lock (same lock markDone takes) so a concurrent writer cannot
// interleave, and appendArchiveLines skips a replayed line whose stamp matches
// an archived one (or falls inside the retry window), so a crash between
// "append" and "rewrite" cannot double-count on the retry. Entries are
// conserved: book + archive before the run equals book + archive after it.

import fs from 'node:fs';
import path from 'node:path';
import type { PathGuard } from '../core/path-guard.js';
import { withFileLock } from '../core/file-lock.js';
import { readText, writeText } from '../vault/vault.js';
import {
  CORRECTIONS_DONE_HEADER,
  CORRECTIONS_HEADER,
  LEDGER_DONE_HEADER,
  LEDGER_HEADER,
  appendArchiveLines,
  correctionsDoneFilePath,
  correctionsFilePath,
  ledgerDoneFilePath,
  ledgerFilePath,
  parseLedgerLine,
} from './ledger.js';

export type AuditSink = (entry: Record<string, unknown>) => void;

export const STATE_FILE = 'state.json';

export function stateFilePath(settingsDir: string): string {
  return path.join(settingsDir, STATE_FILE);
}

/** Plain JSON (settings are plaintext by charter, like policy.json). */
export function readState(guard: PathGuard, settingsDir: string): Record<string, unknown> {
  try {
    const raw = readText(guard, stateFilePath(settingsDir), '');
    if (!raw.trim()) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function writeState(guard: PathGuard, settingsDir: string, state: Record<string, unknown>): void {
  writeText(guard, stateFilePath(settingsDir), JSON.stringify(state, null, 2) + '\n');
}

interface BookSpec {
  /** Audit event prefix: `<label>_done_migrated`. */
  label: 'ledger' | 'corrections';
  marker: 'ledgerDoneMigrated' | 'correctionsDoneMigrated';
  mainFile: string;
  doneFile: string;
  mainHeader: string;
  doneHeader: string;
}

export function bookSpecs(dataDir: string): BookSpec[] {
  return [
    {
      label: 'ledger',
      marker: 'ledgerDoneMigrated',
      mainFile: ledgerFilePath(dataDir),
      doneFile: ledgerDoneFilePath(dataDir),
      mainHeader: LEDGER_HEADER,
      doneHeader: LEDGER_DONE_HEADER,
    },
    {
      label: 'corrections',
      marker: 'correctionsDoneMigrated',
      mainFile: correctionsFilePath(dataDir),
      doneFile: correctionsDoneFilePath(dataDir),
      mainHeader: CORRECTIONS_HEADER,
      doneHeader: CORRECTIONS_DONE_HEADER,
    },
  ];
}

export interface MigrationResult {
  skipped: boolean;
  count: number;
  backup: string | null;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function backupPathFor(guard: PathGuard, file: string, now: number): string {
  const d = new Date(now);
  const stamp =
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-` +
    `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  const base = `${file}.bak-${stamp}`;
  let out = base;
  for (let i = 1; fs.existsSync(guard.assert(out)); i += 1) out = `${base}-${i}`;
  return out;
}

export function migrateBookDone(
  guard: PathGuard,
  spec: BookSpec,
  settingsDir: string,
  audit: AuditSink,
  now = Date.now(),
): MigrationResult {
  return withFileLock(spec.mainFile, () => {
    // Re-check under the lock: the unlocked look-ups saw a snapshot that a
    // concurrent writer (markDone, appendEntry) may already have superseded.
    const state = readState(guard, settingsDir);
    if (state[spec.marker] === true) return { skipped: true, count: 0, backup: null };

    const doneLines: string[] = [];
    const keptLines: string[] = [];
    const exists = fs.existsSync(guard.assert(spec.mainFile));
    if (exists) {
      for (const line of readText(guard, spec.mainFile, spec.mainHeader).split('\n')) {
        const entry = parseLedgerLine(line);
        if (entry && entry.status === 'done') doneLines.push(line);
        else keptLines.push(line);
      }
    }

    let backup: string | null = null;
    // N16⑤: report what the archive actually GREW by, not what the book held.
    // A crash between "append" and "rewrite" replays verbatim lines that the
    // archive already holds; appendArchiveLines then appends 0 and the old
    // `doneLines.length` audit over-claimed.
    let appended = 0;
    if (doneLines.length > 0) {
      backup = backupPathFor(guard, spec.mainFile, now);
      fs.copyFileSync(guard.assert(spec.mainFile), guard.assert(backup));
      appended = appendArchiveLines(guard, spec.doneFile, spec.doneHeader, doneLines, now);
      writeText(guard, spec.mainFile, keptLines.join('\n').replace(/\n*$/, '\n'));
    }

    state[spec.marker] = true;
    writeState(guard, settingsDir, state);
    audit({ event: `${spec.label}_done_migrated`, count: appended, found: doneLines.length });
    return { skipped: false, count: appended, backup };
  });
}

/** Startup entry point: one pass per book, each guarded by its own marker. */
export function runBookDoneMigrations(
  guard: PathGuard,
  dataDir: string,
  settingsDir: string,
  audit: AuditSink,
  now = Date.now(),
): MigrationResult[] {
  return bookSpecs(dataDir).map((spec) => migrateBookDone(guard, spec, settingsDir, audit, now));
}
