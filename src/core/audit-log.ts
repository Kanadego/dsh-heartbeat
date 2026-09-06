// Append-only JSONL audit log with age-based retention pruning.
// Audit files are plaintext by charter (transparency), and must never contain
// sensitive raw observations (window titles, conversation text).

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './atomic-fs.js';

export interface AuditEvent {
  ts: string;
  [key: string]: unknown;
}

export function appendAuditLine(file: string, event: Omit<AuditEvent, 'ts'> & { ts?: string }): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify({ ts: event.ts ?? new Date().toISOString(), ...event });
  fs.appendFileSync(file, line + '\n', 'utf8');
}

export function readAuditLines<T = AuditEvent>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // Skip corrupt lines; the log is diagnostic, not authoritative data.
      out.push({ ts: '', corrupt: true, raw: trimmed.slice(0, 200) } as unknown as T);
    }
  }
  return out;
}

/**
 * Drop entries older than maxAgeMs. Returns the number of removed lines.
 * Rewrites the file atomically; on rewrite failure the original is untouched.
 */
export function pruneAuditFile(file: string, maxAgeMs: number, now = Date.now()): number {
  if (!fs.existsSync(file)) return 0;
  const lines = readAuditLines(file);
  const kept = lines.filter((e) => {
    const ev = e as unknown as AuditEvent;
    const ts = Date.parse(ev.ts ?? '');
    if (!Number.isFinite(ts)) return true; // keep unparseable lines, never lose audit data silently
    return now - ts <= maxAgeMs;
  });
  const removed = lines.length - kept.length;
  if (removed === 0) return 0;
  const body = kept.map((e) => JSON.stringify(e)).join('\n');
  atomicWriteFileSync(file, body ? body + '\n' : '');
  return removed;
}
