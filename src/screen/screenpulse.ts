// Screen pulse (v0.4/v0.9 port). Collects foreground title/process/rect,
// focus window, visible top-level windows (cap 20), and a screenshot
// downsampled to width 1024 - all DPAPI-encrypted at rest (D14).
//
// Discipline: the plaintext window exists only inside data/tmp between the
// PowerShell collector and the vault encryption; raw intermediates are
// removed immediately. Locked content is read on demand only ("use then burn").

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { PathGuard } from '../core/path-guard.js';
import type { WorkspacePaths } from '../core/paths.js';
import { encryptFile, decryptFile } from '../vault/vault.js';

export interface ScreenPulseSummary {
  ok: boolean;
  capturedAt: string | null;
  hasShot: boolean;
  visibleCount: number;
  /** Window class inputs live in encrypted screen.json; never log title/process. */
  error?: string;
}

export interface ScreenJson {
  title: string;
  process: string;
  pid: number;
  rect: { left: number; top: number; right: number; bottom: number } | null;
  screen: [number, number] | null;
  focus: { title: string; process: string; pid: number };
  windows: { title: string; process: string; pid: number }[];
  captured_at: string;
}

const SCREEN_JSON = 'screen.json';
const SCREEN_JPG = 'screen.jpg';

export function screenJsonPath(paths: WorkspacePaths): string {
  return path.join(paths.dataDir, SCREEN_JSON);
}

export function screenJpgPath(paths: WorkspacePaths): string {
  return path.join(paths.dataDir, SCREEN_JPG);
}

/**
 * Run the collector and encrypt results into data/screen.json + screen.jpg.
 * Failure degrades gracefully: heartbeat continues with text-only signals.
 */
export function collectScreen(guard: PathGuard, paths: WorkspacePaths, now = Date.now()): ScreenPulseSummary {
  // The collector writes fixed names into outdir (data/tmp); single-flight in
  // the orchestrator prevents concurrent beats from stomping these files.
  const rawJson = path.join(paths.tmpDir, 'screen.raw.json');
  const rawJpg = path.join(paths.tmpDir, 'screen.raw.jpg');
  let encJson = '';
  try {
    const r = spawnSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(paths.assetsDir, 'screenpulse.ps1'), '-outdir', paths.tmpDir],
      { timeout: 45_000, encoding: 'utf8' });
    if (r.status !== 0) {
      return { ok: false, capturedAt: null, hasShot: false, visibleCount: 0, error: `collector exit ${r.status}` };
    }
    const raw = fs.readFileSync(rawJson, 'utf8');
    const meta = JSON.parse(raw) as ScreenJson & { shot_path?: string };
    if (meta.shot_path && fs.existsSync(meta.shot_path)) {
      try {
        encryptFile(guard, meta.shot_path, screenJpgPath(paths));
      } catch {
        // shot encryption failure: text signals only
      }
    }
    const { shot_path: _drop, ...clean } = meta;
    void _drop;
    encJson = path.join(paths.tmpDir, `screen.enc.${now}.json`);
    fs.writeFileSync(encJson, JSON.stringify(clean, null, 1), 'utf8');
    encryptFile(guard, encJson, screenJsonPath(paths));
    return {
      ok: true,
      capturedAt: meta.captured_at ?? null,
      hasShot: fs.existsSync(screenJpgPath(paths)),
      visibleCount: Array.isArray(meta.windows) ? meta.windows.length : 0,
    };
  } catch (e) {
    return { ok: false, capturedAt: null, hasShot: false, visibleCount: 0, error: String(e) };
  } finally {
    for (const leftover of [rawJson, rawJpg, encJson]) {
      fs.rmSync(leftover, { force: true });
    }
  }
}

/** Read the encrypted screen.json snapshot (auto-decrypt). Null when absent. */
export function readScreenJson(guard: PathGuard, paths: WorkspacePaths): ScreenJson | null {
  const f = screenJsonPath(paths);
  if (!fs.existsSync(guard.assert(f))) return null;
  const tmp = path.join(paths.tmpDir, `screen.read.${Date.now()}.json`);
  try {
    decryptFile(guard, f, guard.assert(tmp));
    return JSON.parse(fs.readFileSync(tmp, 'utf8')) as ScreenJson;
  } catch {
    return null;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * "Use then burn": decrypt the screenshot into data/tmp for on-demand
 * analysis. Caller MUST delete the returned path right after use.
 */
export function unlockShot(guard: PathGuard, paths: WorkspacePaths): string | null {
  const f = screenJpgPath(paths);
  if (!fs.existsSync(guard.assert(f))) return null;
  const tmp = path.join(paths.tmpDir, `screen.view.${Date.now()}.jpg`);
  decryptFile(guard, f, guard.assert(tmp));
  return tmp;
}

export function burnUnlocked(guard: PathGuard, tmpPath: string): void {
  fs.rmSync(guard.assert(tmpPath), { force: true });
}
