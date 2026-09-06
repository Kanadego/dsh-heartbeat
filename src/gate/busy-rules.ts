// Busy/idle classification tables (design doc §6, v0.9 port).
// Process name -> busy | idle; fullscreen games resolve to busy via rect check.

import fs from 'node:fs';
import path from 'node:path';

export interface BusyRules {
  busy: Record<string, string>;
  idle: Record<string, string>;
  rules: {
    focus_stable_seconds: number;
    idle_away_seconds: number;
    idle_floor_seconds: number;
    visible_window_cap: number;
  };
}

export interface WindowInfo {
  process?: string;
  rect?: { left: number; top: number; right: number; bottom: number } | null;
  screen?: [number, number] | null;
}

const own = (obj: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

export const FALLBACK_RULES: BusyRules = {
  busy: {},
  idle: {},
  rules: { focus_stable_seconds: 15, idle_away_seconds: 1200, idle_floor_seconds: 30, visible_window_cap: 20 },
};

export function loadBusyRules(configDir: string): BusyRules {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, 'busy-rules.json'), 'utf8')) as BusyRules;
    if (!raw.busy || !raw.idle) return FALLBACK_RULES;
    return raw;
  } catch {
    return FALLBACK_RULES;
  }
}

/** Process name -> busy | idle | unknown (busy table wins; game rule via fullscreen). */
export function classifyProcess(procName: string | null | undefined, rules: BusyRules): 'busy' | 'idle' | 'unknown' {
  if (!procName) return 'unknown';
  const key = String(procName).toLowerCase().replace(/\.exe$/, '');
  if (own(rules.busy, key)) return 'busy';
  if (own(rules.idle, key)) return 'idle';
  return 'unknown';
}

/**
 * Full window classification: busy-table wins even windowed; idle-table wins
 * even fullscreen; unknown processes fall back to the fullscreen game rule.
 */
export function classifyWindow(
  info: WindowInfo | null,
  rules: BusyRules,
): { cls: 'busy' | 'idle' | 'unknown'; why: string } {
  if (!info || !info.process) return { cls: 'unknown', why: 'no-process' };
  const key = String(info.process).toLowerCase().replace(/\.exe$/, '');
  if (own(rules.busy, key)) return { cls: 'busy', why: key };
  if (own(rules.idle, key)) return { cls: 'idle', why: key };
  if (info.rect && info.screen) {
    const [sw, sh] = info.screen;
    const w = info.rect.right - info.rect.left;
    const h = info.rect.bottom - info.rect.top;
    if (sw > 0 && sh > 0 && w >= sw - 4 && h >= sh - 4) {
      return { cls: 'busy', why: `${key}:fullscreen` };
    }
  }
  return { cls: 'idle', why: key };
}
