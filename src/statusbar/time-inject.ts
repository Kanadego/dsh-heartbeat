// M7b: self-built time injection (design doc §17.6, D20).
//
// Replaces the official dsh-time-context (disabled via the user patch — B9 is
// superseded by D20: time injection has exactly one owner, this module).
//
// Gate (all must pass): step === 1 AND the turn was user-initiated (last
// session event is `agent/inbox/spliced`, P1 ① conclusion) AND the per-session
// throttle interval has elapsed. Mid-task steps are never injected.
// Content: precise local time (+ timezone) and elapsed-since-last-message.
// Transport: pre-step waterfall append — a strict `createUserMessage` message
// (r5 rule: never splice hand-rolled objects). Source attribution
// kind='plugin' keeps the observe phase from ingesting these (C-track rule).

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJsonSync } from '../core/atomic-fs.js';
import { appendAuditLine } from '../core/audit-log.js';
import type { PathGuard } from '../core/path-guard.js';
import type { WorkspacePaths } from '../core/paths.js';
import { sessionEvents } from '../core/orchestrator.js';
import type { HostSession } from '../core/orchestrator.js';

/** Pure gate (§17.6): every condition must hold for an injection. */
export function shouldInjectTime(input: {
  step: number;
  /** Type of the session log's LAST event (`undefined` for an empty log). */
  lastEventType?: string;
  lastInjectAt: number;
  now: number;
  intervalMs: number;
}): boolean {
  if (input.step !== 1) return false;
  if (input.lastEventType !== 'agent/inbox/spliced') return false;
  if (input.intervalMs <= 0) return false;
  return input.now - input.lastInjectAt >= input.intervalMs;
}

function formatElapsed(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}

function localFormatter(timeZone: string | undefined): Intl.DateTimeFormat {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZoneName: 'shortOffset',
  };
  if (timeZone !== undefined) return new Intl.DateTimeFormat('zh-CN', { ...options, timeZone });
  return new Intl.DateTimeFormat('zh-CN', options);
}

/** Render the injected text (§17.6): precise local time + elapsed. Timezone
 * resolution failures fall back to the system zone (never throw to the hook). */
export function renderTimeText(input: {
  now: number;
  timeZone?: string;
  /** Timestamp (`event.time`) of the session's last message event. */
  lastMessageTime?: number;
}): string {
  let timeLine: string;
  try {
    const parts = localFormatter(input.timeZone).formatToParts(new Date(input.now));
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    timeLine = `当前本地时间：${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}（${parts.find((p) => p.type === 'timeZoneName')?.value ?? ''}）。`;
  } catch {
    timeLine = `当前本地时间：${new Date(input.now).toISOString()}。`;
  }
  const elapsedLine = input.lastMessageTime === undefined
    ? ''
    : `\n距本会话上一条消息已过去 ${formatElapsed(input.now - input.lastMessageTime)}。`;
  return timeLine + elapsedLine;
}

/** Timestamp of the session's last user/assistant/tool message event. */
export function lastMessageTime(session: HostSession): number | undefined {
  const events = sessionEvents(session);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    const t = (e as { time?: number }).time;
    if (typeof t === 'number' && /user\/message|assistant\/message|tool\/result/.test(e.type)) return t;
  }
  return undefined;
}

// ── per-session throttle state (survives restarts, like cursors.json) ───

export interface TimeInjectState {
  [sessionId: string]: number;
}

export function timeInjectStatePath(dataDir: string): string {
  return path.join(dataDir, 'time-inject-state.json');
}

export function loadTimeInjectState(guard: PathGuard, dataDir: string): TimeInjectState {
  try {
    const parsed = JSON.parse(fs.readFileSync(guard.assert(timeInjectStatePath(dataDir)), 'utf8')) as TimeInjectState;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveTimeInjectState(guard: PathGuard, dataDir: string, state: TimeInjectState): void {
  atomicWriteJsonSync(guard.assert(timeInjectStatePath(dataDir)), state);
}

// ── registration ─────────────────────────────────────────────────────────

export interface TimeInjectionOptions {
  /** Live-read on every gate check (UI-settable in M7d). */
  getTimeInjectMin(): number;
  timeZone?: string;
  paths: WorkspacePaths;
  logger: { info(msg: string, ...a: unknown[]): void; warn(msg: string, ...a: unknown[]): void };
  onError(error: unknown): void;
  /** Track B status line (§17.5): '' when the statusbar is off or the session
   * rides Track A. Receives the TURN-PINNED track (review #5) so the status
   * line and the system-prompt section can never split one turn. */
  getStatusLine?(session: HostSession, track: 'system-prompt' | 'pre-step'): string;
  /** Pin this turn's track at step===1 (before throttle logic) — every turn
   * start re-pins, so mid-turn capability flips land at the next boundary. */
  pinTrack(sessionId: string, session: HostSession): 'system-prompt' | 'pre-step';
}

interface PreStepPayload {
  agent: { session: HostSession };
  step: number;
  signal?: { aborted?: boolean };
}

interface EnterDecision {
  kind: string;
  messages: unknown[];
}

/**
 * Register the gated time injector on `ctx` (all agents, like the official
 * plugin it replaces). Returns the disposer conceptually owned by the caller's
 * fiber via `ctx.effect`.
 */
export function registerTimeInjection(
  ctx: {
    on(event: string, listener: (payload: PreStepPayload, next: () => Promise<unknown>) => Promise<unknown>, opts?: { prepend?: boolean }): unknown;
  },
  guard: PathGuard,
  dataDir: string,
  opts: TimeInjectionOptions,
): void {
  const state = loadTimeInjectState(guard, dataDir);
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next() as EnterDecision;
    if (decision.kind === 'reject' || payload.signal?.aborted) return decision;
    const events = sessionEvents(payload.agent.session);
    const last = events[events.length - 1];
    const now = Date.now();
    const sessionId = payload.agent.session.id;
    // Turn-start track pin (review #5): re-pinned at EVERY step===1, before
    // any throttle logic, so the pin never goes stale across turns.
    const track = payload.step === 1 ? opts.pinTrack(sessionId, payload.agent.session) : undefined;
    const intervalMs = Math.max(0, opts.getTimeInjectMin()) * 60_000;
    if (!shouldInjectTime({
      step: payload.step,
      lastEventType: last?.type,
      lastInjectAt: state[sessionId] ?? 0,
      now,
      intervalMs,
    })) return decision;
    try {
      const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
      let text = renderTimeText({
        now,
        timeZone: opts.timeZone,
        lastMessageTime: lastMessageTime(payload.agent.session),
      });
      // §17.5: Track B rides the same message with a trailing status line
      // (D21: status text itself never carries time words).
      if (opts.getStatusLine && track) {
        const statusLine = opts.getStatusLine(payload.agent.session, track);
        if (statusLine) text += `\n${statusLine}`;
      }
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'heartbeat', form: 'snapshot', sections: [{ name: 'heartbeat-time', text }] },
      });
      state[sessionId] = now;
      saveTimeInjectState(guard, dataDir, state);
      appendAuditLine(opts.paths.logsDir + '/heartbeat.jsonl', {
        event: 'time_injected', sessionId, intervalMin: opts.getTimeInjectMin(),
      });
      return { ...decision, messages: [...decision.messages, message] };
    } catch (e) {
      opts.onError(e);
      return decision;
    }
  }, { prepend: true });
}
