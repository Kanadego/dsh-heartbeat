// Topic preference (2026-10-06): consumption-driven bias for wander focus
// selection. The persona's seed_report attributions (and the engine-room
// fallback) fold into per-topic delivered/adopted counters; pickFocus reads
// the smoothed rate as a weight on top of round-robin recency.
//
// Anti-lockdown guarantees (user-reviewed design):
//   - weight clamped to [W_MIN, W_MAX] — a favorite doubles at most, a cold
//     topic never drops below half;
//   - Laplace smoothing — a topic with no data sits near neutral, not zero;
//   - exponential decay (30-day half-life) — old glory fades;
//   - pickFocus additionally enforces a hard starvation floor (14 days).
//
// Storage is one JSON file through the vault (DPAPI): topic keys derive from
// the user's profile/interests, so they are user-adjacent data.

import path from 'node:path';
import type { PathGuard } from '../core/path-guard.js';
import { loadJson, saveJson } from '../vault/vault.js';

const DAY_MS = 86_400_000;

export const W_MIN = 0.5;
export const W_MAX = 2;
/** Laplace prior: rate = (adopted + A) / (delivered + D). Neutral ≈ A/D. */
export const SMOOTH_ADOPTED = 1;
export const SMOOTH_DELIVERED = 4;
/** Counts decay with this half-life (days) since the topic's last activity. */
export const DECAY_HALF_LIFE_DAYS = 30;

export interface TopicPref {
  delivered: number;
  adopted: number;
  lastDeliveredAt: number;
  lastAdoptedAt: number;
}

export interface PrefState {
  version: 1;
  topics: Record<string, TopicPref>;
  updatedAt: number;
}

export function preferenceFilePath(dataDir: string): string {
  return path.join(dataDir, 'preference.json');
}

/** Non-negative finite number or 0 (v1.9.0 guard against hand-edited files). */
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** One stored entry → a trustworthy counter. Returns null for a garbled entry:
 *  a NaN delivered/adopted used to survive the load and poison the whole
 *  ordering (NaN makes every comparison false, so the topic neither aged nor
 *  sorted). Dropping the entry is the safe read — the loop refills it. */
function sanitizeTopicPref(raw: unknown): TopicPref | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Partial<TopicPref>;
  if (!Number.isFinite(Number(t.delivered)) || !Number.isFinite(Number(t.adopted))) return null;
  const delivered = Math.floor(num(t.delivered));
  return {
    delivered,
    adopted: Math.min(delivered, Math.floor(num(t.adopted))),
    lastDeliveredAt: num(t.lastDeliveredAt),
    lastAdoptedAt: num(t.lastAdoptedAt),
  };
}

export function loadPreference(guard: PathGuard, file: string): PrefState {
  const doc = loadJson<Partial<PrefState>>(guard, file);
  if (!doc || typeof doc !== 'object' || !doc.topics || typeof doc.topics !== 'object') {
    return { version: 1, topics: {}, updatedAt: 0 };
  }
  const topics: Record<string, TopicPref> = {};
  for (const [key, raw] of Object.entries(doc.topics)) {
    const t = sanitizeTopicPref(raw);
    if (key && t) topics[key] = t;
  }
  const updatedAt = Number(doc.updatedAt);
  return { version: 1, topics, updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0 };
}

export function savePreference(guard: PathGuard, file: string, state: PrefState): void {
  saveJson(guard, file, state);
}

/** Fold one delivery into the counters. offeredTopics = every topic in the
 * package; adoptedTopics = the credited ones (subset by construction — unknown
 * keys are still tolerated so the two lists can drift safely). */
export function recordDelivery(
  guard: PathGuard,
  file: string,
  opts: { offeredTopics: string[]; adoptedTopics: string[]; now: number },
): PrefState {
  const state = loadPreference(guard, file);
  const adopted = new Set(opts.adoptedTopics);
  for (const topic of opts.offeredTopics) {
    if (!topic) continue;
    const t = state.topics[topic] ?? { delivered: 0, adopted: 0, lastDeliveredAt: 0, lastAdoptedAt: 0 };
    t.delivered += 1;
    t.lastDeliveredAt = opts.now;
    if (adopted.has(topic)) {
      t.adopted += 1;
      t.lastAdoptedAt = opts.now;
    }
    state.topics[topic] = t;
  }
  state.updatedAt = opts.now;
  savePreference(guard, file, state);
  return state;
}

/** Time-decayed counts (30-day half-life since last activity of each kind). */
export function decayed(t: TopicPref, now: number): { delivered: number; adopted: number } {
  const dAgeDays = Math.max(0, now - t.lastDeliveredAt) / DAY_MS;
  const aAgeDays = Math.max(0, now - t.lastAdoptedAt) / DAY_MS;
  const dHalf = Math.pow(0.5, dAgeDays / DECAY_HALF_LIFE_DAYS);
  const aHalf = Math.pow(0.5, aAgeDays / DECAY_HALF_LIFE_DAYS);
  return { delivered: t.delivered * dHalf, adopted: t.adopted * aHalf };
}

/**
 * Preference weight for a topic, clamped to [W_MIN, W_MAX]:
 *   rate = (decayed adopted + 1) / (decayed delivered + 4)   (neutral = 0.25)
 *   w    = clamp(rate / 0.25, W_MIN, W_MAX)
 * No data at all → rate 1/4 → w 1.0: a brand-new topic starts exactly neutral
 * (per design: "0.2 附近的中间值，不是 0 分垫底"); repeated "delivered but
 * never adopted" drags it toward W_MIN, consistent adoption lifts it to W_MAX.
 */
export function preferenceWeight(state: PrefState, topic: string, now: number): number {
  const t = state.topics[topic];
  const rate = t
    ? (() => {
        const d = decayed(t, now);
        return (d.adopted + SMOOTH_ADOPTED) / (d.delivered + SMOOTH_DELIVERED);
      })()
    : SMOOTH_ADOPTED / SMOOTH_DELIVERED;
  return Math.min(W_MAX, Math.max(W_MIN, rate / (SMOOTH_ADOPTED / SMOOTH_DELIVERED)));
}
