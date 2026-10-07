// Pace gate ("分寸闸门", design doc §7.5, port of v1 gate.mjs).
// The LAST checkpoint before any expression: quiet hours, busy-window class,
// presence linkage, daily cap, cooldown. Independent layer - the main loop
// cannot bypass it. Every decision is auditable (reason always present).
//
// v2 discipline changes vs v1 (r4 A5): confirmSend is invoked ONLY after the
// delivery channel succeeded; a failed delivery must not consume cap/cooldown.

import path from 'node:path';
import { runPowerShellFile } from '../core/ps.js';
import fs from 'node:fs';
import type { PathGuard } from '../core/path-guard.js';
import type { WorkspacePaths } from '../core/paths.js';
import { inHhMmWindow, minutesOfDay } from '../core/time-window.js';
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

// Fallback only — H-68 (2026-10-07): the live value is
// `busy-rules.json` → `rules.focus_stable_seconds` (v0.9.2: a stale snapshot
// must not decide what the user is focused on).
const STABLE_WINDOW_MS = 15_000;

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
  return inHhMmWindow(q.start, q.end, minutesOfDay(new Date(now)));
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

async function probeFrontWindowLive(guard: PathGuard, paths: WorkspacePaths): Promise<WindowInfo | null> {
  const tmp = path.join(paths.tmpDir, `frontwin.${Date.now()}.json`);
  try {
    const out = guard.assert(tmp);
    const r = await runPowerShellFile(path.join(paths.assetsDir, 'frontwin.ps1'), ['-out', out], 10_000);
    if (r.status !== 0 || !fs.existsSync(out)) return null;
    return JSON.parse(fs.readFileSync(out, 'utf8')) as WindowInfo;
  } catch {
    return null;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Fallback: the beat's screen.json snapshot, but only if fresh enough. */
function probeFrontWindowSnapshot(
  guard: PathGuard,
  paths: WorkspacePaths,
  rules: BusyRules,
): { info: WindowInfo | null; ageMs: number } {
  const screen = readScreenJson(guard, paths);
  if (!screen || !screen.process) return { info: null, ageMs: Number.POSITIVE_INFINITY };
  // H-68: freshness window from the config file, falling back to the constant.
  const limitMs = Number.isFinite(rules.rules.focus_stable_seconds)
    ? rules.rules.focus_stable_seconds * 1000
    : STABLE_WINDOW_MS;
  const ageMs = Date.now() - (Date.parse(screen.captured_at) || 0);
  if (!Number.isFinite(ageMs) || ageMs > limitMs) return { info: null, ageMs };
  return {
    info: { process: screen.process, rect: screen.rect, screen: screen.screen },
    ageMs,
  };
}

async function frontWindowClass(
  guard: PathGuard,
  paths: WorkspacePaths,
  rules: BusyRules,
): Promise<{ cls: 'busy' | 'idle' | 'unknown'; why: string; source: string }> {
  const live = await probeFrontWindowLive(guard, paths);
  if (live) {
    const c = classifyWindow(live, rules);
    return { ...c, source: 'live' };
  }
  const snap = probeFrontWindowSnapshot(guard, paths, rules);
  if (snap.info) {
    const c = classifyWindow(snap.info, rules);
    return { ...c, source: `snapshot(${Math.round(snap.ageMs / 1000)}s)` };
  }
  return { cls: 'unknown', why: 'no-probe', source: 'none' };
}

/** Gather inputs and evaluate. SILENT reasons are audit-ready strings. */
export async function runGate(
  guard: PathGuard,
  policy: Policy,
  paths: WorkspacePaths,
  now = Date.now(),
): Promise<GateDecision> {
  const rules = loadBusyRules(paths.configDir);
  const sent = readSentState(guard, paths, now);
  const front = await frontWindowClass(guard, paths, rules);
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
 * H-67: the pure half of `confirmSend` — read-only, no state change. The
 * orchestrator runs it immediately before the delivery turn, so quiet hours and
 * the daily cap are judged against the state as it is at the moment of
 * speaking instead of minutes earlier (two model turns sit between the gate
 * decision and the delivery).
 */
export function canSend(
  guard: PathGuard,
  policy: Policy,
  paths: WorkspacePaths,
  now = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  const sent = readSentState(guard, paths, now);
  if (inQuietHours(policy, now)) return { ok: false, reason: 'quiet hours' };
  if (sent.items.length >= policy.gate.maxDailySend) {
    return { ok: false, reason: `daily cap reached (${policy.gate.maxDailySend})` };
  }
  return { ok: true };
}

/**
 * Record a delivered expression. Called ONLY after the delivery channel
 * succeeded (r4 A5). Re-reads state from disk, refuses on quiet hours / cap
 * (fail-closed), then persists atomically.
 *
 * H-67: the returned verdict is advisory for the caller — by the time this runs
 * the words are already in the target session, so a refusal here must not be
 * read as "she did not speak"; it only means the books were stale when the
 * second look happened.
 */
export function confirmSend(
  guard: PathGuard,
  policy: Policy,
  paths: WorkspacePaths,
  kind: string,
  summary: string,
  now = Date.now(),
): { ok: true; sent: SentState } | { ok: false; reason: string } {
  const check = canSend(guard, policy, paths, now);
  if (!check.ok) return check;
  const sent = readSentState(guard, paths, now);
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
