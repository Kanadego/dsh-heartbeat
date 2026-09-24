// Card-editable rhythm config (v1.7.0): the heartbeat card edits five fields
// over RPC and they persist in the plugin's OWN user layer, so the editor
// behaves identically on every host generation (0.1.1 scope / 0.1.5
// installSection / 0.1.7 profile forms all become irrelevant for these
// values) and saves apply live without any plugin reload.
// Startup precedence: factory policy < user policy < ui.json < Config fields.

import fs from 'node:fs';
import path from 'node:path';
import type { PathGuard } from '../core/path-guard.js';

export const USER_UI_FILE = 'ui.json';

export interface UiConfig {
  intervalMin?: number;
  maxDailySend?: number;
  timeInjectMin?: number;
  statusbar?: boolean;
  idleMode?: boolean;
  /** Token-saver (v1.7.0): pause beats while the user is away / locked. */
  tokenSaver?: boolean;
}

const RANGES = {
  intervalMin: { min: 1, max: 1440 },
  maxDailySend: { min: 1, max: 50 },
  timeInjectMin: { min: 0, max: 1440 },
} as const;

function sanitize(raw: unknown): UiConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: UiConfig = {};
  for (const key of ['intervalMin', 'maxDailySend', 'timeInjectMin'] as const) {
    const v = r[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= RANGES[key].min && v <= RANGES[key].max) {
      out[key] = Math.floor(v);
    }
  }
  if (typeof r.statusbar === 'boolean') out.statusbar = r.statusbar;
  if (typeof r.idleMode === 'boolean') out.idleMode = r.idleMode;
  if (typeof r.tokenSaver === 'boolean') out.tokenSaver = r.tokenSaver;
  return out;
}

export function uiConfigPath(settingsDir: string): string {
  return path.join(settingsDir, USER_UI_FILE);
}

/** Missing user layer is normal; a corrupt layer fails open to defaults. */
export function loadUiConfig(guard: PathGuard, settingsDir: string): UiConfig {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(guard.assert(uiConfigPath(settingsDir)), 'utf8'));
    return sanitize(raw);
  } catch {
    return {};
  }
}

/** Merge `patch` over the stored layer, sanitize, and persist. */
export function saveUiConfig(guard: PathGuard, settingsDir: string, patch: UiConfig): UiConfig {
  const merged = sanitize({ ...loadUiConfig(guard, settingsDir), ...patch });
  const file = guard.assert(uiConfigPath(settingsDir));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}
