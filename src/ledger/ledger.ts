// Ledger ("账本") - the ONE shared ledger (design doc §5, requirement 5).
// Human-readable Markdown by charter; the user may edit it by hand, so the
// parser is tolerant: unknown lines are preserved verbatim on rewrite.
//
// 2.3.0: books are LIVE-ONLY. markDone 摘走: the row is removed from the book
// and appended verbatim to its archive (`ledger-done.md` / `corrections-done.md`),
// so a human opening the book only sees open items. Archive rows keep the SAME
// `- [date time][done][#id] text` line format and go through the SAME parser
// (readLedger) - only the file path and its header differ. Do not fork the
// parser for the archive.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PathGuard } from '../core/path-guard.js';
import { readText, writeText } from '../vault/vault.js';
import { localDayKey } from '../core/time-window.js';
import { withFileLock } from '../core/file-lock.js';
import { atomicCreateFileSync } from '../core/atomic-fs.js';

const DAY_MS = 86_400_000;

/** Seeded when a book/archive file does not exist yet. */
export const LEDGER_HEADER = '# 账本\n';
export const LEDGER_DONE_HEADER =
  '# 账本归档（不是账本：这里只放已完成的条目）\n\n' +
  '> 由心跳自动维护：账本里勾掉的条目会从 ledger.md 摘出来，原样追加到这里；手编不会被覆盖。\n';
export const CORRECTIONS_HEADER = '# 错题本\n';
export const CORRECTIONS_DONE_HEADER =
  '# 错题本归档（不是错题本：这里只放已复盘的条目）\n\n' +
  '> 由心跳自动维护：错题本里勾掉的条目会从 corrections.md 摘出来，原样追加到这里；手编不会被覆盖。\n';

export interface LedgerEntry {
  id: string;
  date: string; // "YYYY-MM-DD"
  time: string; // "HH:MM"
  status: 'open' | 'done';
  text: string;
}

export function ledgerFilePath(dataDir: string): string {
  return path.join(dataDir, 'ledger.md');
}

/** Archive of completed ledger rows (2.3.0). Derived, never guessed: the book
 *  path is the single source of truth for where its archive lives. */
export function ledgerDoneFilePath(dataDir: string): string {
  return path.join(dataDir, 'ledger-done.md');
}

/** 错题本 (v1.10.0): same format, another file. */
export function correctionsFilePath(dataDir: string): string {
  return path.join(dataDir, 'corrections.md');
}

/** Archive of reviewed corrections (2.3.0). */
export function correctionsDoneFilePath(dataDir: string): string {
  return path.join(dataDir, 'corrections-done.md');
}

/** `<name>.md` → `<name>-done.md` in the same directory. */
export function doneFilePathFor(file: string): string {
  const ext = path.extname(file);
  return `${file.slice(0, file.length - ext.length)}-done${ext}`;
}

/** The two books are deliberately the only callers; anything else gets the
 *  ledger archive header rather than a fourth header nobody asked for. */
export function doneHeaderFor(file: string): string {
  return path.basename(file).toLowerCase().startsWith('corrections')
    ? CORRECTIONS_DONE_HEADER
    : LEDGER_DONE_HEADER;
}

// The id is written by hand sometimes (`#net-backup-20260914`), and a
// `{6}` hex rule silently dropped such rows: they stayed in rawLines but never
// became entries, so scanPending failed to see them and markDone could not
// find them. Any run of non-] non-space characters parses now; ids this plugin
// generates itself are still 6 hex chars of a UUID.
const LINE_RE = /^- \[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\]\[(open|done)\]\[#([^\]\s]+)\] (.*)$/;

function renderEntry(e: LedgerEntry): string {
  return `- [${e.date} ${e.time}][${e.status}][#${e.id}] ${e.text}`;
}

/** A retried completion is re-stamped by markDone, so the same id+text may
 *  arrive with a new minute (crash between archive append and book rewrite).
 *  Two rows are the same completion only when their stamps are within this
 *  window; a completion repeated next month is a NEW completion and must be
 *  archived again (weekly "done" counts it). */
const RETRY_WINDOW_MS = 10 * 60_000;
// A DST shift moves the wall clock without moving real time: ten REAL minutes
// across a spring-forward shift render 70 wall minutes apart (01:55 → 03:05).
// Wall deltas up to one hour beyond the retry window are the same completion
// (N16② cross-review: the old Date.parse arithmetic got this right by
// accident — epoch math hides the wall gap; the component form exposes it, so
// the grace has to restore the dedupe explicitly).
//
// Design consequence (N16② review, pinned by the 30-minute test): a REAL
// second completion of the same id+text inside those 70 wall minutes is
// swallowed too. The archive keeps one row, and the weekly report — which
// counts done by archive rows (src/weekly/collect.ts) — under-counts by one;
// the `book_done_deduped` audit is the only trace.
const RETRY_WALL_GRACE_MS = 60 * 60_000;
// A stamp AFTER `now` is clock skew, a hand edit or a cross-timezone re-render
// — not a second completion. But only for a day: beyond that the archive must
// self-heal, or one year-2099 stamp would dedupe every future real completion
// of the item and silently under-count the weekly report forever (N16④).
const FUTURE_GRACE_MS = 24 * 60 * 60_000;
// Known limitation (N16② review, pinned by the Asia/Shanghai test): the window
// is single-sided ON PURPOSE. A timezone move WESTWARD re-reads a fresh stamp
// as before-`now` — covered by the future grace above. A move EASTWARD renders
// `now` up to ~14 wall hours AHEAD of the archived stamp, which is
// indistinguishable from a real completion that many hours later; extending
// the window that far would swallow real completions, so an eastward move may
// archive the same completion twice and the weekly report may over-count by
// one.

/** N16②: both sides of every stamp comparison collapse to the stamp's own
 *  wall-clock components (Date.UTC is timezone-free) instead of Date.parse,
 *  which re-interprets the same "12:00" through the current process zone.
 *  Honest scope: within ONE process at a stable timezone the two forms are
 *  equivalent — offsets cancel (the cross-review measured oldDelta ===
 *  newDelta under UTC / +08:00 / America/New_York), and the observed "+08:00
 *  archived, retried under UTC" double-archive is actually fixed by the
 *  single-sided window in appendArchiveLines, which reads a foreign-zone
 *  re-render as a before-`now` (future-stamp) retry. What the component form
 *  buys over Date.parse is the DST boundary above: wall math exposes the
 *  shifted gap that epoch math hides, and the DST grace turns it back into a
 *  retry instead of a double-archive. */
function completionStamp(e: LedgerEntry): number {
  const [y, mo, d] = e.date.split('-').map(Number);
  const [h, mi] = e.time.split(':').map(Number);
  return Date.UTC(y!, mo! - 1, d!, h!, mi!);
}

/** The `now` side of the same comparison, in the same component space: a wall
 *  stamp may only be measured against another wall stamp, never against an
 *  epoch whose local rendering shifts with the timezone. */
function localWallStamp(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes());
}

/** Why a done line was judged already-archived instead of appended. The
 *  wall-clock grace carries a self-describing name: it exists for DST shifts
 *  but swallows ANY same-id+text retry within the extended wall window, so
 *  `retry-window-extended`, not `dst-grace` (N16② review). */
export type ArchiveDedupeReason = 'same-stamp' | 'retry-window' | 'retry-window-extended' | 'future-stamp';
/** `date`/`time` are the matched ARCHIVE row's own stamp — the audit uses them
 *  to locate the swallowed line, since the retried completion carries a fresh
 *  minute (N16② review 低4). */
export type ArchiveDedupeSink = (info: { id: string; reason: ArchiveDedupeReason; date: string; time: string }) => void;

/** One parser for every book and every archive - a line is a line, whichever
 *  file it lives in. Returns null for headers, blank lines and hand edits. */
export function parseLedgerLine(line: string): LedgerEntry | null {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  return { date: m[1]!, time: m[2]!, status: m[3] as 'open' | 'done', id: m[4]!, text: m[5]! };
}

export function readLedger(guard: PathGuard, file: string, header = LEDGER_HEADER): { header: string; entries: LedgerEntry[]; rawLines: string[] } {
  const raw = readText(guard, file, header);
  const lines = raw.split('\n');
  const entries: LedgerEntry[] = [];
  const rawLines: string[] = [];
  for (const line of lines) {
    const e = parseLedgerLine(line);
    if (e) entries.push(e);
    rawLines.push(line);
  }
  return { header: lines[0] ?? header, entries, rawLines };
}

/** Seed a book/archive header only when the file does not exist yet. Exclusive
 *  creation via the atomic-fs helper (AGENTS.md #1), never "exists? then
 *  write": a live markDone may have created the file with header+rows between
 *  the check and the write, and the old pattern overwrote that first
 *  completion. EEXIST means someone else owns it. */
export function seedBookFile(guard: PathGuard, file: string, header: string): void {
  try {
    atomicCreateFileSync(guard.assert(file), header);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
}

export function appendEntry(guard: PathGuard, file: string, text: string, now = Date.now(), header = LEDGER_HEADER): LedgerEntry {
  const textTrimmed = text.trim();
  if (!textTrimmed) throw new Error('ledger entry must not be empty');
  return withFileLock(file, () => {
    const d = new Date(now);
    const pad = (n: number) => String(n).padStart(2, '0');
    const entry: LedgerEntry = {
      id: randomUUID().slice(0, 6),
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
      status: 'open',
      text: textTrimmed.replace(/\r?\n/g, ' '),
    };
    const { rawLines } = readLedger(guard, file, header);
    rawLines.push(renderEntry(entry));
    writeText(guard, file, rawLines.join('\n').replace(/\n*$/, '\n'));
    return entry;
  });
}

/** Append rows to an archive, skipping completions already present. A done
 *  row dedupes when id+text+status agree AND either the stamps are identical
 *  (migration replays lines verbatim, whatever their age) or the archived
 *  stamp is within RETRY_WINDOW_MS of `now` — extended by RETRY_WALL_GRACE_MS
 *  on the late side (DST wall shifts), and bounded to FUTURE_GRACE_MS on the
 *  future side so a skewed stamp cannot swallow real completions forever
 *  (N16③④). Same id+text completed again weeks later is a real second
 *  completion and IS appended.
 *  Unknown/hand-written lines still dedupe verbatim.
 *  `onDedupe` (N16①) reports each skipped line with the reason it matched, so
 *  callers can audit a swallowed completion.
 *  This is what makes "append then remove" retry-safe: a crash between the two
 *  writes leaves the row open in the book, and the retry must not double the
 *  archive line. */
export function appendArchiveLines(
  guard: PathGuard,
  file: string,
  header: string,
  lines: string[],
  now = Date.now(),
  onDedupe?: ArchiveDedupeSink,
): number {
  if (lines.length === 0) return 0;
  const { rawLines, entries } = readLedger(guard, file, header);
  const rawSeen = new Set(rawLines);
  const archived = entries.filter((e) => e.status === 'done');
  const nowWall = localWallStamp(now);
  const fresh = lines.filter((line) => {
    const e = parseLedgerLine(line);
    if (!e) {
      if (rawSeen.has(line)) return false;
      rawSeen.add(line);
      return true;
    }
    const stamp = completionStamp(e);
    // N16③: the window is SINGLE-SIDED. Math.abs judged a FUTURE-stamped row
    // (hand edit, clock skew, cross-timezone re-render) far from `now` as a
    // NEW completion and double-archived it; `now - stamp <= WINDOW` reads any
    // stamp at-or-after `now` (negative delta) as a retry instead — bounded by
    // FUTURE_GRACE_MS so the archive self-heals past a skewed stamp (N16④).
    let hit: { id: string; reason: ArchiveDedupeReason; date: string; time: string } | null = null;
    for (const x of archived) {
      if (x.id !== e.id || x.text !== e.text || x.status !== e.status) continue;
      const stampX = completionStamp(x);
      if (stampX === stamp) {
        hit = { id: e.id, reason: 'same-stamp', date: x.date, time: x.time };
        break;
      }
      const delta = nowWall - stampX;
      if (delta < 0) {
        if (delta >= -FUTURE_GRACE_MS) {
          hit = { id: e.id, reason: 'future-stamp', date: x.date, time: x.time };
          break;
        }
        continue; // skewed beyond the grace: this is a NEW completion
      }
      if (delta <= RETRY_WINDOW_MS) {
        hit = { id: e.id, reason: 'retry-window', date: x.date, time: x.time };
        break;
      }
      if (delta <= RETRY_WINDOW_MS + RETRY_WALL_GRACE_MS) {
        hit = { id: e.id, reason: 'retry-window-extended', date: x.date, time: x.time };
        break;
      }
    }
    if (hit) {
      onDedupe?.(hit);
      return false;
    }
    archived.push(e);
    return true;
  });
  if (fresh.length === 0) return 0;
  const out = rawLines.concat(fresh);
  writeText(guard, file, out.join('\n').replace(/\n*$/, '\n'));
  return fresh.length;
}

/** Mark an entry done by id (preferred) or unique text substring. 2.3.0:
 *  the row is REMOVED from the book and appended to its archive in the same
 *  line format, so both a human reading the book and the weekly report (which
 *  reads the archive) see the completion. The done date is restamped to the
 *  completion day so weekly reporting can count "resolved this week".
 *
 *  The book is a whole-file rewrite and the CLI is a second process against
 *  it, so read→archive→write runs under the book's file lock (H-20): two
 *  interleaved cycles would otherwise let one side silently drop the other's
 *  write, and a stale snapshot could even resurrect a row just marked done.
 *
 *  N16①: when the archive dedupes the line (same stamp, retry window, the
 *  extended wall grace or a future-stamped row), the completion still leaves
 *  the book but is NOT appended — callers that can audit pass a sink and get a
 *  `book_done_deduped` record. The audit fires only AFTER the book rewrite
 *  succeeded: a failed rewrite leaves the row in the book (nothing was
 *  swallowed) and a crash before it means the retry redoes the whole cycle.
 *  Hand-written ids can carry personal text (`#家人的生日`), so only the
 *  plugin-generated 6-hex ids enter the audit log; the archive file name
 *  locates the row either way. Row text is never audited. */
export type LedgerAuditSink = (entry: Record<string, unknown>) => void;

const HEX_ID_RE = /^[0-9a-f]{6}$/;

export function markDone(
  guard: PathGuard,
  file: string,
  key: string,
  now = Date.now(),
  doneFile = doneFilePathFor(file),
  doneHeader = doneHeaderFor(file),
  audit?: LedgerAuditSink,
): LedgerEntry | null {
  return withFileLock(file, () => {
    const { rawLines, entries } = readLedger(guard, file);
    const target = entries.find((e) => e.status === 'open' && (e.id === key || e.text.includes(key)));
    if (!target) return null;
    const d = new Date(now);
    const pad = (n: number) => String(n).padStart(2, '0');
    const doneDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const doneTime = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    // Only rows that ARE this entry (same id AND text, still open) are摘走.
    // A hand note that merely mentions `#abc123] ` or another row reusing the
    // id with different text is not this completion and stays in the book.
    const isTargetRow = (line: string): boolean => {
      const e = parseLedgerLine(line);
      return e !== null && e.status === 'open' && e.id === target.id && e.text === target.text;
    };
    // Exactly ONE row is removed: two byte-identical rows are two entries, and
    // removing both while archiving one would lose the other (the migration
    // conservation invariant applies here too).
    const targetIndex = rawLines.findIndex(isTargetRow);
    const doneLine = renderEntry({
      ...parseLedgerLine(rawLines[targetIndex]!)!,
      status: 'done',
      date: doneDate,
      time: doneTime,
    });
    // Archive first: a crash between the writes leaves the row visible (still
    // open) instead of losing it; appendArchiveLines dedupes the retry even
    // when the retry restamps the minute. A dedupe hit with nothing appended
    // means this completion was already archived — audited below (N16①).
    let dedupeHits: { id: string; reason: ArchiveDedupeReason; date: string; time: string }[] = [];
    const appended = appendArchiveLines(guard, doneFile, doneHeader, [doneLine], now, (info) => {
      dedupeHits.push(info);
    });
    const out = rawLines.filter((_, i) => i !== targetIndex);
    writeText(guard, file, out.join('\n').replace(/\n*$/, '\n'));
    // Audit AFTER the rewrite succeeded: a failed rewrite leaves the row in
    // the book, and then nothing was swallowed — recording it would log a
    // dedupe that never happened, and every crash retry would re-log it.
    if (appended === 0 && dedupeHits.length > 0) {
      const hit = dedupeHits[0]!;
      audit?.({
        event: 'book_done_deduped',
        // Hand-written ids may carry personal text; only generated 6-hex ids
        // are audited (the archive file name locates the row regardless).
        ...(HEX_ID_RE.test(target.id) ? { id: target.id } : {}),
        archive: path.basename(doneFile),
        // The matched archive row's OWN stamp locates the swallowed line; the
        // done stamp below is this retry's fresh minute, useless for finding
        // the row it deduped against (N16② review 低4).
        rowDate: hit.date,
        rowTime: hit.time,
        doneDate,
        doneTime,
        reason: hit.reason,
      });
    }
    return target;
  });
}

/** Open items for the reflection digest (§7.6 账本待办). */
export function scanPending(guard: PathGuard, file: string, now = Date.now()): LedgerEntry[] {
  const { entries } = readLedger(guard, file);
  return entries.filter((e) => e.status === 'open').sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Open entries older than N days (跟进时机的"自然到期"参考，§3.1 四问之一). */
export function pendingOlderThan(guard: PathGuard, file: string, days: number, now = Date.now()): LedgerEntry[] {
  const cutoff = localDayKey(new Date(now - days * DAY_MS));
  return scanPending(guard, file, now).filter((e) => e.date <= cutoff);
}
