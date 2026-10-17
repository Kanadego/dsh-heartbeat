// Excerpt book ("摘抄本") - the place for lines worth keeping.
//
// Deliberately plaintext Markdown, like the ledger: a notebook that cannot be
// read is not a notebook. The two plaintext files in data/ are the ledger
// (his todos) and this one (her clippings); everything private stays in KHBV2
// containers. The user may edit it by hand, so the parser is tolerant:
// unrecognised lines are preserved verbatim on rewrite.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PathGuard } from '../core/path-guard.js';
import { readText, writeText } from '../vault/vault.js';

export interface ExcerptEntry {
  id: string;
  date: string; // "YYYY-MM-DD"
  time: string; // "HH:MM"
  text: string;
}

/** Used both as the read fallback and as the file the settings card opens, so
 *  a fresh notebook already carries the two lines that explain it. */
export const EXCERPT_HEADER = '# 摘抄本\n\n> 留句子和小事的地方。可以直接手编，改乱了也不影响：认不出的行会原样留着。\n\n';

export function excerptFilePath(dataDir: string): string {
  return path.join(dataDir, 'excerpts.md');
}

const LINE_RE = /^- \[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\]\[#([0-9a-f]{6})\] (.*)$/;

function renderEntry(e: ExcerptEntry): string {
  return `- [${e.date} ${e.time}][#${e.id}] ${e.text}`;
}

export function readExcerpts(guard: PathGuard, file: string): { entries: ExcerptEntry[]; rawLines: string[] } {
  const raw = readText(guard, file, EXCERPT_HEADER);
  const rawLines: string[] = [];
  const entries: ExcerptEntry[] = [];
  for (const line of raw.split('\n')) {
    const m = LINE_RE.exec(line);
    if (m) entries.push({ date: m[1]!, time: m[2]!, id: m[3]!, text: m[4]! });
    rawLines.push(line);
  }
  return { entries, rawLines };
}

/** Append one clipping, stamped with the local wall clock (like the ledger). */
export function appendExcerpt(guard: PathGuard, file: string, text: string, now = Date.now()): ExcerptEntry {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('excerpt must not be empty');
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  const entry: ExcerptEntry = {
    id: randomUUID().slice(0, 6),
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    text: trimmed.replace(/\r?\n/g, ' '),
  };
  const { rawLines } = readExcerpts(guard, file);
  rawLines.push(renderEntry(entry));
  writeText(guard, file, rawLines.join('\n').replace(/\n*$/, '\n'));
  return entry;
}

/** Tear one page out by id (preferred) or unique text substring. Unlike the
 *  ledger there is no done-state: a clipping either stays or is gone. */
export function removeExcerpt(guard: PathGuard, file: string, key: string): ExcerptEntry | null {
  const { rawLines, entries } = readExcerpts(guard, file);
  const target = entries.find((e) => e.id === key || e.text.includes(key));
  if (!target) return null;
  const out = rawLines.filter((line) => !line.startsWith(`- [${target.date} ${target.time}][#${target.id}] `));
  writeText(guard, file, out.join('\n').replace(/\n*$/, '\n'));
  return target;
}

/** The tail of the notebook, oldest-first among the newest `limit` entries. */
export function recentExcerpts(guard: PathGuard, file: string, limit: number): ExcerptEntry[] {
  const { entries } = readExcerpts(guard, file);
  return limit > 0 ? entries.slice(-limit) : [];
}
