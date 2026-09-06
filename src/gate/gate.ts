// Pace gate ("分寸闸门", design doc §7.5, port of v1 gate.mjs).
// The LAST checkpoint before any expression: quiet hours, busy-window class,
// presence linkage, daily cap, cooldown. Independent layer - the main loop
// cannot bypass it. Every decision is auditable (reason always present).
//
// v2 discipline changes vs v1 (r4 A5): confirmSend is invoked ONLY after the
// delivery channel succeeded; a failed delivery must not consume cap/cooldown.

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { PathGuard } from '../core/path-guard.js';
import type { WorkspacePaths } from '../core/paths.js';
import { loadJson, saveJson } from '../vault/vault.js';
import type { Policy } from '../config/schema.js';
import { classifyWindow, loadBusyRules, type BusyRules, type WindowInfo } from './busy-rules.js';
import { readPulse } from '../env/envpulse.js';
import { readScreenJson } from '../screen/screenpulse.js';

export interface SentItem {
  ts: number;
  iso: string;
  kind: string;
  summary: string;
}

export interface SentState {
  today: string;
  items: SentItem[];
}

export type GateDecision =
  | { verdict: 'SILENT'; reason: string }
  | { verdict: 'SPEAK'; sentToday: number; cap: number; window: { cls: string; why: string; source: string } };

const STABLE_WINDOW_MS = 15_000; // v0.9.2: snapshots older than 15s are not trusted

export function sentFilePath(paths: WorkspacePaths): string {
  return path.join(paths.dataDir, 'sent.json');
}

function localDay(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function readSentState(guard: PathGuard, paths: WorkspacePaths, now = Date.now()): SentState {
  const stored = loadJson<SentState>(guard, sentFilePath(paths));
  const today = localDay(now);
  return stored && stored.today === today && Array.isArray(stored.items)
    ? stored
    : { today, items: [] };
}

export function inQuietHours(policy: Policy, now = Date.now()): boolean {
  const q = policy.gate.quietHours;
  const d = new Date(now);
  const mins = d.getHours() * 60 + d.getMinutes();
  const [sh, sm] = q.start.split(':').map(Number);
  const [eh, em] = q.end.split(':').map(Number);
  const start = sh! * 60 + sm!;
  const end = eh! * 60 + em!;
  return start > end ? mins >= start || mins < end : mins >= start && mins < end;
}

// ── pure decision core (unit-tested without any IO) ─────────────────────

export interface GateInputs {
  now: number;
  policy: Policy;
  sent: SentState;
  presence: string | null;
  frontClass: 'busy' | 'idle' | 'unknown';
  frontWhy: string;
  frontSource: string;
}

export function evaluateGate(input: GateInputs): GateDecision {
  const { policy, sent, now } = input;
  if (inQuietHours(policy, now)) return { verdict: 'SILENT', reason: 'quiet hours' };
  if (input.frontClass === 'busy') {
    return { verdict: 'SILENT', reason: `busy window (${input.frontWhy})` };
  }
  if (input.presence === 'active') {
    return { verdict: 'SILENT', reason: `master actively typing (front=${input.frontClass})` };
  }
  if (sent.items.length >= policy.gate.maxDailySend) {
    return { verdict: 'SILENT', reason: `daily cap reached (${policy.gate.maxDailySend})` };
  }
  if (sent.items.length > 0) {
    const last = sent.items[sent.items.length - 1]!.ts;
    const leftMs = policy.gate.cooldownMinutes * 60_000 - (now - last);
    if (leftMs > 0) {
      return { verdict: 'SILENT', reason: `cooldown ${Math.ceil(leftMs / 60_000)}min left` };
    }
  }
  return {
    verdict: 'SPEAK',
    sentToday: sent.items.length,
    cap: policy.gate.maxDailySend,
    window: { cls: input.frontClass, why: input.frontWhy, source: input.frontSource },
  };
}

// ── probing (IO layer) ──────────────────────────────────────────────────

function probeFrontWindowLive(guard: PathGuard, paths: WorkspacePaths): WindowInfo | null {
  const tmp = path.join(paths.tmpDir, `frontwin.${Date.now()}.json`);
  try {
    const out = guard.assert(tmp);
    const r = spawnSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(paths.assetsDir, 'frontwin.ps1'), '-out', out],
      { timeout: 10_000, encoding: 'utf8' });
    if (r.status !== 0 || !fs.existsSync(out)) return null;
    return JSON.parse(fs.readFileSync(out, 'utf8')) as WindowInfo;
  } catch {
    return null;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Fallback: the beat's screen.json snapshot, but only if fresh (< 15s). */
function probeFrontWindowSnapshot(
  guard: PathGuard,
  paths: WorkspacePaths,
): { info: WindowInfo | null; ageMs: number } {
  const screen = readScreenJson(guard, paths);
  if (!screen || !screen.process) return { info: null, ageMs: Number.POSITIVE_INFINITY };
  const ageMs = Date.now() - (Date.parse(screen.captured_at) || 0);
  if (!Number.isFinite(ageMs) || ageMs > STABLE_WINDOW_MS) return { info: null, ageMs };
  return {
    info: { process: screen.process, rect: screen.rect, screen: screen.screen },
    ageMs,
  };
}

function frontWindowClass(
  guard: PathGuard,
  paths: WorkspacePaths,
  rules: BusyRules,
): { cls: 'busy' | 'idle' | 'unknown'; why: string; source: string } {
  const live = probeFrontWindowLive(guard, paths);
  if (live) {
    const c = classifyWindow(live, rules);
    return { ...c, source: 'live' };
  }
  const snap = probeFrontWindowSnapshot(guard, paths);
  if (snap.info) {
    const c = classifyWindow(snap.info, rules);
    return { ...c, source: `snapshot(${Math.round(snap.ageMs / 1000)}s)` };
  }
  return { cls: 'unknown', why: 'no-probe', source: 'none' };
}

/** Gather inputs and evaluate. SILENT reasons are audit-ready strings. */
export function runGate(
  guard: PathGuard,
  policy: Policy,
  paths: WorkspacePaths,
  now = Date.now(),
): GateDecision {
  const rules = loadBusyRules(paths.configDir);
  const sent = readSentState(guard, paths, now);
  const front = frontWindowClass(guard, paths, rules);
  const pulse = readPulse(guard, paths);
  return evaluateGate({
    now,
    policy,
    sent,
    presence: pulse?.presence ?? null,
    frontClass: front.cls,
    frontWhy: front.why,
    frontSource: front.source,
  });
}

/**
 * Record a delivered expression. Called ONLY after the delivery channel
 * succeeded (r4 A5). Re-reads state from disk, refuses on quiet hours / cap
 * (fail-closed), then persists atomically.
 */
export function confirmSend(
  guard: PathGuard,
  policy: Policy,
  paths: WorkspacePaths,
  kind: string,
  summary: string,
  now = Date.now(),
): { ok: true; sent: SentState } | { ok: false; reason: string } {
  const sent = readSentState(guard, paths, now);
  if (inQuietHours(policy, now)) return { ok: false, reason: 'quiet hours' };
  if (sent.items.length >= policy.gate.maxDailySend) {
    return { ok: false, reason: `daily cap reached (${policy.gate.maxDailySend})` };
  }
  sent.items.push({
    ts: now,
    iso: new Date(now).toISOString(),
    kind,
    summary: String(summary).slice(0, 80),
  });
  saveJson(guard, sentFilePath(paths), sent);
  return { ok: true, sent };
}

export function gateStatus(guard: PathGuard, policy: Policy, paths: WorkspacePaths, now = Date.now()): {
  today: string;
  sent: number;
  cap: number;
  quiet: boolean;
} {
  const sent = readSentState(guard, paths, now);
  return {
    today: sent.today,
    sent: sent.items.length,
    cap: policy.gate.maxDailySend,
    quiet: inQuietHours(policy, now),
  };
}
