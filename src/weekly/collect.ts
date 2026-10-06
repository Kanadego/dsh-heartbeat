// Weekly report facts collector (v1.8.0). Deterministic code pass over the
// stores the heartbeat already keeps - NO LLM here, NO new probing. The report
// writer (weekly/report.ts) turns these facts into prose; the card and the CLI
// render them raw. Facts are the single source of truth, so a degraded
// template-only report still tells the truth.

import fs from 'node:fs';
import type { PathGuard } from '../core/path-guard.js';
import type { WorkspacePaths } from '../core/paths.js';
import type { Policy } from '../config/schema.js';
import { readAuditLines } from '../core/audit-log.js';
import { journalFilePath } from '../profile/store.js';
import { readLedger, pendingOlderThan, ledgerFilePath } from '../ledger/ledger.js';
import { loadPool, seedsFilePath, activeSeeds } from '../seeds/pool.js';
import { readSeedReports, reportFilePath } from '../seeds/report.js';
import { summarizeRhythm } from '../rhythm/rhythm.js';

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 7;

export interface WeeklyFacts {
  windowStart: string;
  windowEnd: string;
  /** Expression + gate activity from the audit log (30d retention, covers 7d). */
  spoken: number;
  silent: number;
  silentTopReasons: { reason: string; count: number }[];
  observedItems: number;
  /** Profile entries merged from conversation this week (journal ADD ops). */
  profileAdds: { partition: string; topic: string; content: string }[];
  ledger: {
    added: string[];
    done: string[];
    stale: { text: string; days: number }[];
  };
  seeds: {
    added: string[];
    consumed: string[];
    /** Active, never-surfaced topic seeds - what the pool is holding back. */
    waiting: string[];
    poolActive: number;
  };
  peakHours: string[];
  /** v1.9.0: the persona's seed_report accounting this week. */
  reports: {
    total: number;
    material: number;
    heartfelt: number;
    silent: number;
    /** deliveries that ended with no usable report at all (audit event
     *  report_missing) — the number that says how much of the week went
     *  unaccounted, so a rise is visible instead of silent. */
    missing: number;
    reasons: { reason: string; count: number }[];
  };
}

function inWindow(ts: string, start: number, end: number): boolean {
  const t = Date.parse(ts);
  return Number.isFinite(t) && t >= start && t <= end;
}

function trim(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Gather everything the report needs. Never throws on per-store gaps: a
 * missing/corrupt store contributes an empty section, not a failed report. */
export function collectWeeklyFacts(guard: PathGuard, paths: WorkspacePaths, policy: Policy, now = Date.now()): WeeklyFacts {
  const start = now - WINDOW_DAYS * DAY_MS;
  const end = now;

  // 1) audit activity (heartbeat.jsonl is plaintext by charter).
  let spoken = 0;
  let silent = 0;
  let observedItems = 0;
  let reportMissing = 0;
  const reasons = new Map<string, number>();
  try {
    for (const e of readAuditLines(paths.logsDir + '/heartbeat.jsonl')) {
      const ts = (e as { ts?: string }).ts ?? '';
      if (!inWindow(ts, start, end)) continue;
      const ev = (e as { event?: string }).event;
      if (ev === 'spoke') spoken += 1;
      else if (ev === 'report_missing') reportMissing += 1;
      else if (ev === 'silent') {
        silent += 1;
        const reason = String((e as { reason?: string }).reason ?? 'unknown').slice(0, 60);
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      } else if (ev === 'observed') {
        observedItems += Number((e as { added?: number }).added ?? 0);
      }
    }
  } catch { /* audit unreadable: counts stay zero */ }

  // 2) profile adds from the journal (plaintext JSONL; ADD ops only).
  const profileAdds: WeeklyFacts['profileAdds'] = [];
  try {
    const raw = fs.readFileSync(journalFilePath(paths.dataDir), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as { ts?: string; applied?: { op?: string; partition?: string; topic?: string; subTopic?: string; content?: string }[] };
        if (!inWindow(rec.ts ?? '', start, end)) continue;
        for (const op of rec.applied ?? []) {
          if (op.op !== 'ADD' || !op.content) continue;
          profileAdds.push({
            partition: String(op.partition ?? '?'),
            topic: String(op.subTopic ? `${op.topic}/${op.subTopic}` : (op.topic ?? '?')),
            content: trim(op.content, 60),
          });
        }
      } catch { /* skip a corrupt journal line */ }
    }
  } catch { /* no journal yet */ }

  // 3) ledger: added / done-this-week / stale open items.
  const ledger = { added: [] as string[], done: [] as string[], stale: [] as { text: string; days: number }[] };
  try {
    const { entries } = readLedger(guard, ledgerFilePath(paths.dataDir));
    for (const e of entries) {
      const t = Date.parse(`${e.date}T${e.time}:00`);
      if (Number.isFinite(t) && t >= start && t <= end) {
        (e.status === 'done' ? ledger.done : ledger.added).push(trim(e.text, 40));
      }
    }
    const staleCutoffDays = 12;
    for (const e of pendingOlderThan(guard, ledgerFilePath(paths.dataDir), staleCutoffDays, now)) {
      const days = Math.max(1, Math.round((now - Date.parse(`${e.date}T${e.time}:00`)) / DAY_MS));
      ledger.stale.push({ text: trim(e.text, 40), days });
    }
  } catch { /* no ledger yet */ }

  // 4) material pool: fresh inflow, consumed, and what is waiting its turn.
  const seeds = { added: [] as string[], consumed: [] as string[], waiting: [] as string[], poolActive: 0 };
  try {
    const db = loadPool(guard, seedsFilePath(paths.dataDir));
    seeds.poolActive = activeSeeds(db).length;
    for (const s of db.seeds) {
      if (inWindow(s.bornAt, start, end)) seeds.added.push(trim(s.text, 40));
      if (s.status === 'archived' && s.retireReason === 'consumed' && s.retiredAt && inWindow(s.retiredAt, start, end)) {
        seeds.consumed.push(trim(s.text, 40));
      }
    }
    seeds.waiting = activeSeeds(db)
      .filter((s) => s.used === 0 && s.category === 'topic')
      .sort((a, b) => (a.bornAt < b.bornAt ? 1 : -1))
      .slice(0, 5)
      .map((s) => trim(s.text, 40));
  } catch { /* pool unreadable */ }

  // 4b) seed reports (v1.9.0): what the persona actually did with deliveries.
  const reports = { total: 0, material: 0, heartfelt: 0, silent: 0, missing: reportMissing, reasons: [] as { reason: string; count: number }[] };
  try {
    const reasonTally = new Map<string, number>();
    for (const r of readSeedReports(guard, reportFilePath(paths.dataDir))) {
      if (r.ts < start || r.ts > end) continue;
      reports.total += 1;
      if (r.spoken === 'material') reports.material += 1;
      else if (r.spoken === 'heartfelt') reports.heartfelt += 1;
      else reports.silent += 1;
      if (r.reason) reasonTally.set(r.reason, (reasonTally.get(r.reason) ?? 0) + 1);
    }
    reports.reasons = [...reasonTally.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
  } catch { /* no reports yet */ }

  // 5) rhythm peaks (aggregate histogram only - no titles, no content).
  let peakHours: string[] = [];
  try {
    peakHours = summarizeRhythm(paths).peakHours;
  } catch { /* rhythm file missing */ }

  return {
    windowStart: new Date(start).toISOString(),
    windowEnd: new Date(end).toISOString(),
    spoken,
    silent,
    silentTopReasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3),
    observedItems,
    profileAdds,
    ledger,
    seeds,
    reports,
    peakHours,
  };
}
