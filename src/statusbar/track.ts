// M7c: statusbar tracks (design doc §17.4–17.5, §17.7, D19/D21).
//
// One status store, two transports, picked per agent by model capability:
//   Track A — in-history-capable models: a dynamic system-prompt section
//             (`heartbeat:status`). The host projection layer dedupes (text
//             unchanged → zero commit) and appends changed prompts after the
//             cached history (KV-safe). Incapable/disabled → the text function
//             returns '' and the section drops out of the render entirely.
//   Track B — every other model: the pre-step time-injection message gains a
//             trailing status line (see time-inject.ts `getStatusLine`).
// Track evidence: the session log's latest `request/context` event carries the
// route's `systemPromptUpdate` mode. No evidence yet (fresh session) → Track B
// (§17.7 default). Red line D21: status text NEVER contains time words.

import { appendAuditLine } from '../core/audit-log.js';
import { sessionEventCount, sessionEvents } from '../core/orchestrator.js';
import type { HostSession } from '../core/orchestrator.js';
import type { PathGuard } from '../core/path-guard.js';
import type { WorkspacePaths } from '../core/paths.js';
import { StatusReader } from './store.js';
import type { StatusState } from './store.js';

// ── capability probe (琥珀 review 2026-09-13 #1: incremental tail scan) ───
// Cache keyed by "how far we've scanned", NOT by log length: the length grows
// every step, so a length key would miss (and rescan the whole log backwards)
// on every assembly. We remember the scan watermark and, on new events, read
// only the tail (snapshotEvents(fromSeq) range) for NEW request/context rows.
interface CapabilityCache {
  /** Event count at the time of the last scan. */
  scannedUpTo: number;
  supported: boolean;
}
const capabilityCache = new Map<string, CapabilityCache>();

export function supportsInHistory(session: HostSession): boolean {
  const key = session.id;
  const len = sessionEventCount(session);
  const hit = capabilityCache.get(key);
  if (hit && hit.scannedUpTo === len) return hit.supported;
  // Log shrank (session reset under the same id) → rescan from zero.
  const from = hit && len >= hit.scannedUpTo ? hit.scannedUpTo : 0;
  let supported = false;
  if (from !== 0 && hit) supported = hit.supported;
  const readTail = (fromSeq: number): { type: string; data?: unknown }[] => {
    if (typeof session.snapshotEvents === 'function') {
      try {
        const slice = session.snapshotEvents(fromSeq);
        if (Array.isArray(slice)) return slice;
      } catch { /* fall through to the legacy full read */ }
    }
    return sessionEvents(session).slice(fromSeq);
  };
  for (const e of readTail(from)) {
    if (e.type === 'request/context') {
      supported = (e.data as { systemPromptUpdate?: string } | undefined)?.systemPromptUpdate === 'in-history';
    }
  }
  capabilityCache.set(key, { scannedUpTo: len, supported });
  return supported;
}

/** Forget cached capability (test helper; also bounds memory across deletes). */
export function resetCapabilityCache(): void {
  capabilityCache.clear();
}

const SCENE_LABELS: Record<StatusState['scene'], string> = {
  'quiet-hours': '静默时段，世界睡了',
  'just-spoke': '刚去和你说过话',
  wandering: '正在闲逛看新东西',
  busy: '看到你在忙，不去打扰',
  present: '在场待着',
  away: '你不在，自己待着',
};

/** Render the one-line status text (D21 red line: zero time words).
 *
 * RENDER PURITY RED LINE (2026-09-13 review): this MUST stay a pure function
 * of the status state — no clock reads, no counters, no per-call variability.
 * The host projection already refuses to commit identical text (project()
 * emits no updates when the rendered prompt is byte-identical), so purity here
 * is what keeps the in-history append cadence at "per scene change", not "per
 * step". Any field varying faster than the scene belongs in the time
 * injection, never here.
 *
 * NOTE POLICY (琥珀 review 2026-09-13 #3): `withNote: false` for the Track A
 * section — the scene label is a constant-table mapping (maximally stable),
 * while the note is engine-room free text that can differ every beat and
 * would defeat the host's byte-dedupe. The note is for the UI and the Track B
 * pre-step line (where each message is small and already event-shaped). */
export function renderStatusText(
  status: StatusState | null,
  opts?: { withNote?: boolean },
): string {
  if (!status) return '';
  const label = SCENE_LABELS[status.scene] ?? '在场';
  const note = opts?.withNote === false ? '' : status.note ? `——${status.note}` : '';
  return `心跳此刻：${label}${note}。`;
}

// ── turn-pinned track decision (2026-09-13 review #5) ────────────────────
// The track must be decided ONCE per turn, at its start (step===1 in the
// pre-step listener), and both transports read that pin. Otherwise a
// capability flip mid-turn (e.g. the very first request of a fresh capable
// session lands `request/context` after step 1) splits the turn: the pre-step
// status line already in history AND the section activating from the next
// step. A pin updates only at turn starts, so a flip always lands cleanly at
// the next turn boundary.
const pinnedTrack = new Map<string, 'system-prompt' | 'pre-step'>();

/** Pin and return this turn's track. Call from the pre-step listener at
 * step===1 (before any throttle logic) — every turn start re-pins. */
export function pinTrack(sessionId: string, session: HostSession): 'system-prompt' | 'pre-step' {
  const track = trackFor(session);
  pinnedTrack.set(sessionId, track);
  return track;
}

/** The pinned track when one exists for this session, else the live probe
 * (fallback for assemblies that somehow precede any turn-start pin). */
export function pinnedTrackFor(sessionId: string, session: HostSession): 'system-prompt' | 'pre-step' {
  return pinnedTrack.get(sessionId) ?? trackFor(session);
}

export function resetPins(): void {
  pinnedTrack.clear();
}

/** Track-change auditor: emits `statusbar_track` only when an agent's track
 * actually flips (bounded spam; called from the two render paths). */
const lastTrack = new Map<string, string>();

export function noteTrack(auditFile: string, sessionId: string, track: 'system-prompt' | 'pre-step' | 'off'): void {
  if (lastTrack.get(sessionId) === track) return;
  lastTrack.set(sessionId, track);
  try {
    appendAuditLine(auditFile, { event: 'statusbar_track', sessionId, track });
  } catch { /* audit failure must not break rendering */ }
}

/** Forget a session's track memo (test helper). */
export function resetTrackMemo(): void {
  lastTrack.clear();
}

/** Which transport serves this session right now (§17.7: no evidence yet →
 * Track B; the section flip happens once a request/context event lands). */
export function trackFor(session: HostSession): 'system-prompt' | 'pre-step' {
  return supportsInHistory(session) ? 'system-prompt' : 'pre-step';
}

/** Register the Track A section on the host systemPrompt service. The text
 * provider returns '' (section drops from the render) when the statusbar is
 * off, the agent is unknown, or the session rides Track B. */
export function registerStatusbarSection(
  ctx: {
    inject(services: string[], callback: (scoped: unknown) => void): void;
  },
  guard: PathGuard,
  paths: WorkspacePaths,
  opts: { enabled(): boolean; reader: StatusReader },
): void {
  ctx.inject(['systemPrompt'], (scoped) => {
    const spCtx = scoped as {
      systemPrompt?: {
        section(def: { name: string; order: number; text: string | ((context: unknown) => string) }): unknown;
      };
      effect(fn: () => unknown, label?: string): () => void;
      logger?: { warn(msg: string, ...a: unknown[]): void };
    };
    const section = spCtx.systemPrompt?.section;
    if (typeof section !== 'function') {
      spCtx.logger?.warn('heartbeat: systemPrompt service has no section API, statusbar Track A unavailable');
      return;
    }
    spCtx.effect(() => section.call(spCtx.systemPrompt, {
      name: 'heartbeat:status',
      order: 5000, // between the persona prefix (0) and the harness block (10000)
      text: (context: unknown) => {
        if (!opts.enabled()) {
          noteTrack(paths.logsDir + '/heartbeat.jsonl', (context as { agent?: { session: HostSession } }).agent?.session.id ?? '(none)', 'off');
          return '';
        }
        const agent = (context as { agent?: { session?: HostSession } }).agent;
        if (!agent?.session) return '';
        // Read the TURN-PINNED track (2026-09-13 review #5): a mid-turn
        // capability flip must not activate the section inside the same turn
        // whose pre-step status line already went out on Track B.
        const track = pinnedTrackFor(agent.session.id, agent.session);
        noteTrack(paths.logsDir + '/heartbeat.jsonl', agent.session.id, track);
        if (track !== 'system-prompt') return '';
        return renderStatusText(opts.reader.read(guard, paths), { withNote: false });
      },
    }), 'heartbeat: statusbar section');
  });
}
