// Rhythm aggregator (design doc §3.2 profile_rhythm.json): deterministic
// statistics over presence samples - NO LLM, NO semantic content (aggregate
// histogram only, no window titles ever). 30-day rolling with exponential
// decay. Raw pulses stream lives in logs/envpulse.jsonl (48h retention, §14).

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJsonSync } from '../core/atomic-fs.js';
import type { EnvSnapshot } from '../env/envpulse.js';

export interface RhythmFile {
  histogram: Record<string, Record<string, { active: number; present: number; away: number }>>;
  days: string[];
  lastDecayAt: string;
}

const DAY_MS = 86_400_000;
const TAU_DAYS = 10; // decay constant: ~10d half-life-ish

function rhythmFilePath(paths: { dataDir: string }): string {
  return path.join(paths.dataDir, 'profile_rhythm.json');
}

function loadRhythm(paths: { dataDir: string }): RhythmFile {
  try {
    return JSON.parse(fs.readFileSync(rhythmFilePath(paths), 'utf8')) as RhythmFile;
  } catch {
    return { histogram: {}, days: [], lastDecayAt: new Date().toISOString() };
  }
}

function saveRhythm(paths: { dataDir: string }, state: RhythmFile): void {
  atomicWriteJsonSync(rhythmFilePath(paths), state);
}

/** Record one beat's presence sample and decay old evidence. */
export function recordPresence(paths: { dataDir: string }, env: EnvSnapshot, now = Date.now()): void {
  const state = loadRhythm(paths);
  const decayFactor = Math.exp(-(now - Date.parse(state.lastDecayAt)) / (TAU_DAYS * DAY_MS));
  for (const wd of Object.keys(state.histogram)) {
    for (const h of Object.keys(state.histogram[wd]!)) {
      const cell = state.histogram[wd]![h]!;
      cell.active *= decayFactor;
      cell.present *= decayFactor;
      cell.away *= decayFactor;
    }
  }
  state.lastDecayAt = new Date(now).toISOString();

  const wd = String(new Date(now).getDay());
  const h = String(new Date(now).getHours());
  state.histogram[wd] ??= {};
  state.histogram[wd]![h] ??= { active: 0, present: 0, away: 0 };
  const cell = state.histogram[wd]![h]!;
  if (env.presence === 'active') cell.active += 1;
  else if (env.presence === 'away') cell.away += 1;
  else cell.present += 1;

  const dayKey = new Date(now).toISOString().slice(0, 10);
  if (!state.days.includes(dayKey)) state.days.push(dayKey);
  if (state.days.length > 30) state.days.shift(); // 30-day rolling window
  saveRhythm(paths, state);
}

export interface RhythmSummary {
  daysSampled: number;
  peakHours: string[];
}

/** Compact human-readable summary for the tact digest slice. */
export function summarizeRhythm(paths: { dataDir: string }): RhythmSummary {
  const state = loadRhythm(paths);
  const score: { key: string; active: number }[] = [];
  for (const wd of Object.keys(state.histogram)) {
    for (const h of Object.keys(state.histogram[wd]!)) {
      const cell = state.histogram[wd]![h]!;
      score.push({ key: `${h}时(周${'日一二三四五六'[Number(wd)]})`, active: cell.active });
    }
  }
  score.sort((a, b) => b.active - a.active);
  return {
    daysSampled: state.days.length,
    peakHours: score.filter((s) => s.active > 0).slice(0, 6).map((s) => s.key),
  };
}
