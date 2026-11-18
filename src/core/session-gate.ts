// 2.3.0 P0-4: the one gate that answers "may this session enter the heartbeat's
// view?" — shared by observe, deliver, the notepad tool and both statusbar
// transports. Three skip reasons:
//
//   archived  — the disk truth in <dshHome>/storages/workspace.json (reuses
//               archived-sessions.ts); delivering into one ends the turn
//               `blocked` with zero output (H-archived).
//   subagent  — header.origin / delegationDepth / the first events' descriptor
//               marker; extracted from statusbar/time-inject.ts (re-exported
//               there for existing importers).
//   broken    — the session log cannot be read (snapshotEvents throws) or the
//               last turn/end carries `reason == null` (issue #11's shape;
//               fixed at the producer, still guarded for historical logs).
//
// Verdicts are cached for 60s so one beat pays for at most one probe per
// session (observe and deliver both run in the same beat). A pass clears the
// broken-strike counter; broken sessions are only auto-removed after
// BROKEN_STRIKES_TO_REMOVE consecutive misses, because a transient read
// failure is not proof the session is damaged.

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJsonSync } from './atomic-fs.js';
import { appendAuditLine } from './audit-log.js';
import { isArchivedSession, loadArchivedSessionIds } from './archived-sessions.js';
import { loadBindings } from './bindings.js';
import type { PathGuard } from './path-guard.js';
import type { HostSession } from './orchestrator.js';

export type SessionSkipReason = 'archived' | 'subagent' | 'broken';

export const SESSION_GATE_TTL_MS = 60_000;
export const BROKEN_STRIKES_TO_REMOVE = 3;

interface GateEvent {
  type?: unknown;
  data?: unknown;
}

interface GateSessionProbe {
  header?: { origin?: string; delegationDepth?: number };
}

/** Subagent verdict: header fields are cheap and exact; otherwise scan the
 *  first 8 events for the descriptor marker every subagent logs at seq 0. */
export function isSubagentSession(session: HostSession | undefined): boolean {
  if (!session) return false;
  const header = (session as HostSession & GateSessionProbe).header;
  if (header?.origin === 'subagent') return true;
  if (typeof header?.delegationDepth === 'number' && header.delegationDepth > 0) return true;
  return readEventsLenient(session).slice(0, 8).some((e) => e?.type === 'subagent/descriptor');
}

/** The harness accessor with the same fallback chain as orchestrator's
 *  sessionEvents (snapshot first, legacy array second), but swallowing failures
 *  — the subagent scan must stay total. `null` from the strict probe below is
 *  what marks a session broken. */
function readEventsLenient(session: HostSession): GateEvent[] {
  if (typeof session.snapshotEvents === 'function') {
    try {
      const snapshot = session.snapshotEvents();
      if (Array.isArray(snapshot)) return snapshot;
    } catch { /* fall through to the legacy accessor */ }
  }
  return Array.isArray(session.events) ? (session.events as GateEvent[]) : [];
}

/** Strict read used only for the broken verdict: an unreadable (or oddly
 *  shaped) snapshot is itself the evidence. */
function readEventsStrict(session: HostSession): GateEvent[] | null {
  try {
    if (typeof session.snapshotEvents === 'function') {
      const snapshot = session.snapshotEvents();
      return Array.isArray(snapshot) ? snapshot : null;
    }
    return Array.isArray(session.events) ? (session.events as GateEvent[]) : [];
  } catch {
    return null;
  }
}

/** Broken when the log cannot be read, or the LAST turn/end carries an
 *  explicit `reason: null`. Missing data or a missing `reason` key is NOT
 *  evidence of damage — bare turn/end rows appear in the repo's own fixtures
 *  and the orchestrator treats the same shape defensively (turnEndKindSince).
 *  Only the tail matters: a null reason buried in older history must not
 *  poison a session whose recent turns end cleanly. */
export function sessionLooksBroken(session: HostSession): boolean {
  const events = readEventsStrict(session);
  if (events === null) return true;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type !== 'turn/end') continue;
    const d = e.data;
    if (typeof d !== 'object' || d === null || !('reason' in d)) return false;
    return (d as { reason?: unknown }).reason == null;
  }
  return false;
}

// ── 60s verdict cache ───────────────────────────────────────────────────

interface GateCacheEntry {
  reason: SessionSkipReason | null;
  at: number;
  /** true when the probe had a session (subagent/broken were evaluated). */
  full: boolean;
}

const gateCache = new Map<string, GateCacheEntry>();

/** Test helper: forget cached verdicts between sandboxes. */
export function resetSessionGateCache(): void {
  gateCache.clear();
}

export interface SessionGateProbe {
  sessionId: string;
  /** Live harness session. Omitted on the deliver pre-pass, where only the
   *  archived registry can be consulted before a resume. */
  session?: HostSession;
  registryFile?: string;
  now?: number;
  ttlMs?: number;
  /** When present, an allowed verdict clears this session's broken strikes.
   *  Passive callers (statusbar, notepad) pass their workspace so one healthy
   *  probe is enough to reset the counter, exactly like a heartbeat verdict. */
  guard?: PathGuard;
  settingsDir?: string;
}

/** Pure gate: `null` = allowed, otherwise the first failing reason in
 *  archived → subagent → broken order. Cache hits never re-read the log. */
export function checkSessionGate(probe: SessionGateProbe): SessionSkipReason | null {
  const now = probe.now ?? Date.now();
  const ttl = probe.ttlMs ?? SESSION_GATE_TTL_MS;
  const full = probe.session !== undefined;
  const hit = gateCache.get(probe.sessionId);
  if (hit && now - hit.at < ttl && (!full || hit.full)) {
    if (hit.reason === null && hit.full && probe.settingsDir) {
      clearBrokenStrikes(probe.guard, probe.settingsDir, probe.sessionId);
    }
    return hit.reason;
  }

  const reason = evaluateSession(probe);
  gateCache.set(probe.sessionId, { reason, at: now, full });
  if (reason === null && full && probe.settingsDir) {
    clearBrokenStrikes(probe.guard, probe.settingsDir, probe.sessionId);
  }
  return reason;
}

function evaluateSession(probe: SessionGateProbe): SessionSkipReason | null {
  const archived = loadArchivedSessionIds(probe.registryFile);
  if (isArchivedSession(archived, probe.sessionId)) return 'archived';
  const session = probe.session;
  if (!session) return null;
  try {
    if (isSubagentSession(session)) return 'subagent';
  } catch {
    return 'broken';
  }
  return sessionLooksBroken(session) ? 'broken' : null;
}

// ── broken-strike bookkeeping (data/settings/state.json) ────────────────

interface StrikeRecord {
  count: number;
  lastAt: string;
}

interface GateStateFile {
  brokenStrikes?: Record<string, StrikeRecord>;
  [key: string]: unknown;
}

function gateStateFilePath(settingsDir: string): string {
  return path.join(settingsDir, 'state.json');
}

function readGateState(file: string): GateStateFile {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return raw && typeof raw === 'object' ? (raw as GateStateFile) : {};
  } catch {
    return {};
  }
}

function writeGateState(guard: PathGuard | undefined, file: string, state: GateStateFile): void {
  atomicWriteJsonSync(guard ? guard.assert(file) : file, state);
}

/** Drop one session's broken-strike entry. Writes only when the entry exists,
 *  so a healthy beat never rewrites state.json. Returns true when it cleared. */
export function clearBrokenStrikes(
  guard: PathGuard | undefined,
  settingsDir: string,
  sessionId: string,
): boolean {
  return clearBrokenStrikesAt(guard, gateStateFilePath(settingsDir), sessionId);
}

function clearBrokenStrikesAt(guard: PathGuard | undefined, file: string, sessionId: string): boolean {
  const state = readGateState(file);
  const strikesMap = state.brokenStrikes;
  if (!strikesMap?.[sessionId]) return false;
  delete strikesMap[sessionId];
  const next: GateStateFile = { ...state };
  if (Object.keys(strikesMap).length === 0) delete next.brokenStrikes;
  else next.brokenStrikes = strikesMap;
  writeGateState(guard, file, next);
  return true;
}

export interface UnreachableStrikeInput {
  sessionId: string;
  guard?: PathGuard;
  settingsDir: string;
  brokenThreshold?: number;
  now?: number;
}

/** A delivery target that was really brought up (resume WAS attempted) and
 *  failed to come live. Shares the broken strike ledger: such a session can
 *  never reach the post-resume health probe, so without this counter its
 *  binding would live forever. Never call this for observe's "not live right
 *  now" — that is normal and must not accrue strikes. */
export function recordUnreachableStrike(input: UnreachableStrikeInput): {
  strikes: number;
  removeBinding: boolean;
} {
  const now = input.now ?? Date.now();
  const threshold = input.brokenThreshold ?? BROKEN_STRIKES_TO_REMOVE;
  const stateFile = gateStateFilePath(input.settingsDir);
  const state = readGateState(stateFile);
  const strikesMap = state.brokenStrikes ?? {};
  const strikes = (strikesMap[input.sessionId]?.count ?? 0) + 1;
  strikesMap[input.sessionId] = { count: strikes, lastAt: new Date(now).toISOString() };
  writeGateState(input.guard, stateFile, { ...state, brokenStrikes: strikesMap });
  return { strikes, removeBinding: strikes >= threshold };
}

// ── binding policy (observe / deliver) ──────────────────────────────────

export interface BoundSessionGateInput extends SessionGateProbe {
  guard?: PathGuard;
  settingsDir: string;
  auditFile?: string;
  brokenThreshold?: number;
}

export interface BoundSessionGateResult {
  allowed: boolean;
  reason: SessionSkipReason | null;
  /** true when the binding should be dropped from data/settings/bindings.json:
   *  archived/subagent on first sight, broken only after N consecutive beats. */
  removeBinding: boolean;
  brokenStrikes: number;
  cached: boolean;
}

/** The heartbeat-facing entry point: verdict + auto-removal policy + audit.
 *  `session_skipped` is written once per (per-TTL) denial; a cached denial
 *  (observe and deliver in the same beat) does not log twice. */
export function gateBoundSession(input: BoundSessionGateInput): BoundSessionGateResult {
  const now = input.now ?? Date.now();
  const ttl = input.ttlMs ?? SESSION_GATE_TTL_MS;
  const threshold = input.brokenThreshold ?? BROKEN_STRIKES_TO_REMOVE;
  const full = input.session !== undefined;
  const hit = gateCache.get(input.sessionId);
  const cached = hit && now - hit.at < ttl && (!full || hit.full) ? hit : null;
  const stateFile = gateStateFilePath(input.settingsDir);
  let reason: SessionSkipReason | null;
  let strikes = 0;

  if (cached) {
    reason = cached.reason;
    if (reason === 'broken') {
      strikes = readGateState(stateFile).brokenStrikes?.[input.sessionId]?.count ?? 0;
    }
  } else {
    reason = evaluateSession(input);
    gateCache.set(input.sessionId, { reason, at: now, full });
    if (reason === 'broken') {
      const state = readGateState(stateFile);
      const strikesMap = state.brokenStrikes ?? {};
      strikes = (strikesMap[input.sessionId]?.count ?? 0) + 1;
      strikesMap[input.sessionId] = { count: strikes, lastAt: new Date(now).toISOString() };
      writeGateState(input.guard, stateFile, { ...state, brokenStrikes: strikesMap });
    }
    if (reason && input.auditFile) {
      try {
        appendAuditLine(input.auditFile, { event: 'session_skipped', sessionId: input.sessionId, reason });
      } catch { /* audit must never break a beat */ }
    }
  }

  // Any successful FULL evaluation resets the streak — cached or fresh, active
  // beat or passive probe. An archived-only pre-pass (no session) is not a
  // health probe and must not erase a strike it cannot judge.
  if (reason === null && full) clearBrokenStrikesAt(input.guard, stateFile, input.sessionId);

  return {
    allowed: reason === null,
    reason,
    removeBinding: reason === 'broken' ? strikes >= threshold : reason !== null,
    brokenStrikes: strikes,
    cached: cached !== null,
  };
}

// ── "is this a delivery session?" (notepad + statusbar) ─────────────────

export interface DeliverySessionCheckInput {
  sessionId: string;
  session?: HostSession;
  guard: PathGuard;
  settingsDir: string;
  registryFile?: string;
  now?: number;
}

export interface DeliverySessionVerdict {
  allowed: boolean;
  /** gate reason, 'not-bound' or 'not-deliver'; null when allowed. */
  reason: string | null;
}

/** Passive check: gate passes AND the binding says deliver === true. Never
 *  increments strikes or audits — but a passing gate DOES clear the broken
 *  streak (one good probe is one good probe). Removal stays the heartbeat
 *  loops' decision. */
export function checkDeliverySession(input: DeliverySessionCheckInput): DeliverySessionVerdict {
  const gateReason = checkSessionGate({
    sessionId: input.sessionId,
    session: input.session,
    registryFile: input.registryFile,
    now: input.now,
    guard: input.guard,
    settingsDir: input.settingsDir,
  });
  if (gateReason) return { allowed: false, reason: gateReason };
  const binding = loadBindings(input.guard, input.settingsDir).bindings
    .find((b) => b.sessionId === input.sessionId);
  if (!binding) return { allowed: false, reason: 'not-bound' };
  if (binding.deliver !== true) return { allowed: false, reason: 'not-deliver' };
  return { allowed: true, reason: null };
}
