// Ledger ("账本") - the ONE shared ledger (design doc §5, requirement 5).
// Human-readable Markdown by charter; the user may edit it by hand, so the
// parser is tolerant: unknown lines are preserved verbatim on rewrite.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PathGuard } from '../core/path-guard.js';
import { readText, writeText } from '../vault/vault.js';

const DAY_MS = 86_400_000;

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

const LINE_RE = /^- \[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\]\[(open|done)\]\[#([0-9a-f]{6})\] (.*)$/;

function renderEntry(e: LedgerEntry): string {
  return `- [${e.date} ${e.time}][${e.status}][#${e.id}] ${e.text}`;
}

export function readLedger(guard: PathGuard, file: string): { header: string; entries: LedgerEntry[]; rawLines: string[] } {
  const raw = readText(guard, file, '# 账本\n');
  const lines = raw.split('\n');
  const entries: LedgerEntry[] = [];
  const rawLines: string[] = [];
  for (const line of lines) {
    const m = LINE_RE.exec(line);
    if (m) {
      entries.push({ date: m[1]!, time: m[2]!, status: m[3] as 'open' | 'done', id: m[4]!, text: m[5]! });
    }
    rawLines.push(line);
  }
  return { header: lines[0] ?? '# 账本', entries, rawLines };
}

export function appendEntry(guard: PathGuard, file: string, text: string, now = Date.now()): LedgerEntry {
  const textTrimmed = text.trim();
  if (!textTrimmed) throw new Error('ledger entry must not be empty');
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  const entry: LedgerEntry = {
    id: randomUUID().slice(0, 6),
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    status: 'open',
    text: textTrimmed.replace(/\r?\n/g, ' '),
  };
  const { rawLines } = readLedger(guard, file);
  rawLines.push(renderEntry(entry));
  writeText(guard, file, rawLines.join('\n').replace(/\n*$/, '\n'));
  return entry;
}

/** Mark an entry done by id (preferred) or unique text substring. */
export function markDone(guard: PathGuard, file: string, key: string, now = Date.now()): LedgerEntry | null {
  const { rawLines, entries } = readLedger(guard, file);
  const target = entries.find((e) => e.status === 'open' && (e.id === key || e.text.includes(key)));
  if (!target) return null;
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  const out = rawLines.map((line) => {
    if (line.includes(`#${target.id}] `)) {
      return `- [${target.date} ${pad(d.getHours())}:${pad(d.getMinutes())}][done][#${target.id}] ${target.text}`;
    }
    return line;
  });
  writeText(guard, file, out.join('\n').replace(/\n*$/, '\n'));
  return target;
}

/** Open items for the reflection digest (§7.6 账本待办). */
export function scanPending(guard: PathGuard, file: string, now = Date.now()): LedgerEntry[] {
  const { entries } = readLedger(guard, file);
  return entries.filter((e) => e.status === 'open').sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Open entries older than N days (跟进时机的"自然到期"参考，§3.1 四问之一). */
export function pendingOlderThan(guard: PathGuard, file: string, days: number, now = Date.now()): LedgerEntry[] {
  const cutoff = new Date(now - days * DAY_MS).toISOString().slice(0, 10);
  return scanPending(guard, file, now).filter((e) => e.date <= cutoff);
}
