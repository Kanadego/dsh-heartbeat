// Observation inbox (design doc §3.2): append-only queue of pending
// observations; drained by the consolidation run. DPAPI-encrypted. Items hold
// pointers + at most one short sentence - never raw conversation/screen text.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PathGuard } from '../core/path-guard.js';
import { loadEncryptedText, saveEncryptedText } from '../vault/vault.js';
import type { InboxItem } from './types.js';

const MAX_NOTE_CHARS = 120;

export function inboxFilePath(dataDir: string): string {
  return path.join(dataDir, 'profile_inbox.jsonl');
}

function truncateNote(note: string): string {
  const oneLine = note.replace(/\r?\n/g, ' ').trim();
  return oneLine.length > MAX_NOTE_CHARS ? oneLine.slice(0, MAX_NOTE_CHARS) + '…' : oneLine;
}

export function inboxAppend(
  guard: PathGuard,
  file: string,
  item: Omit<InboxItem, 'id'> & { id?: string },
): InboxItem {
  const full: InboxItem = {
    id: item.id ?? randomUUID().slice(0, 8),
    kind: item.kind,
    at: item.at,
    ref: item.ref,
    note: truncateNote(item.note),
  };
  const prev = loadEncryptedText(guard, file) ?? '';
  saveEncryptedText(guard, file, prev + JSON.stringify(full) + '\n');
  return full;
}

export function inboxCount(guard: PathGuard, file: string): number {
  const raw = loadEncryptedText(guard, file);
  if (!raw) return 0;
  return raw.split('\n').filter((l) => l.trim()).length;
}

/**
 * Drain all items. `commit` controls crash semantics: on consolidation failure
 * the inbox must SURVIVE (§3.7), so the caller drains with commit=false first,
 * and only rewrites an empty inbox after the run succeeded.
 */
export function inboxDrain(guard: PathGuard, file: string): InboxItem[] {
  const raw = loadEncryptedText(guard, file);
  if (!raw) return [];
  const items: InboxItem[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      items.push(JSON.parse(trimmed) as InboxItem);
    } catch {
      // corrupt line: drop (queue is re-derivable from sources)
    }
  }
  return items;
}

export function inboxClear(guard: PathGuard, file: string): void {
  saveEncryptedText(guard, file, '');
}

/** Dedupe key (§3.7): same source kind + same ref must not flood the queue. */
export function dedupeItems(items: InboxItem[]): InboxItem[] {
  const seen = new Set<string>();
  const out: InboxItem[] = [];
  for (const it of items) {
    const key = `${it.kind}#${it.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

export function inboxHealthCheck(guard: PathGuard, file: string): { total: number; corrupt: number; duplicates: number } {
  const raw = loadEncryptedText(guard, file) ?? '';
  let total = 0;
  let corrupt = 0;
  const keys = new Set<string>();
  let duplicates = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const it = JSON.parse(trimmed) as InboxItem;
      total += 1;
      const key = `${it.kind}#${it.ref}`;
      if (keys.has(key)) duplicates += 1;
      keys.add(key);
    } catch {
      corrupt += 1;
    }
  }
  return { total, corrupt, duplicates };
}

export function inboxFileExists(guard: PathGuard, file: string): boolean {
  return fs.existsSync(guard.assert(file));
}
