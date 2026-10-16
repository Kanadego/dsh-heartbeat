// Screen pulse (v0.4/v0.9 port). Collects foreground title/process/rect,
// focus window, visible top-level windows (cap 20), and a FULL-screen
// screenshot at native resolution (spec ①, 2026-09-18) - all DPAPI-encrypted
// at rest (D14).
//
// Discipline: the plaintext window exists only inside data/tmp between the
// PowerShell collector and the vault encryption; raw intermediates are
// removed immediately. Locked content is read on demand only ("use then burn").

import fs from 'node:fs';
import path from 'node:path';
import { runPowerShellFile } from '../core/ps.js';
import type { PathGuard } from '../core/path-guard.js';
import type { WorkspacePaths } from '../core/paths.js';
import { encryptFile, decryptFile } from '../vault/vault.js';
import { burnFileSync } from '../core/atomic-fs.js';

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

const SCREEN_STAMP = 'screen.capture';

/**
 * HB-15: the beat stamp. It is written in the same commit as the screenshot and
 * the screen.json snapshot, and dropped with them; it names the captured_at
 * that both carry. A picture on disk is only "this beat's" when the stamp says
 * so - existence alone cannot tell a fresh shot from last beat's leftover.
 * Plaintext on purpose: one ISO timestamp, no private content.
 */
export function screenStampPath(paths: WorkspacePaths): string {
  return path.join(paths.dataDir, SCREEN_STAMP);
}

/** Read the beat stamp; '' when absent or unreadable. */
export function readScreenStamp(paths: WorkspacePaths): string {
  try {
    return fs.readFileSync(screenStampPath(paths), 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * HB-15: is the picture on disk this beat's own? True only when the file is
 * there, the stamp is there, and both name the same captured_at as the
 * screen.json snapshot. Existence is not ownership - a leftover from an earlier
 * beat fails this test and must not be described as "now".
 */
export function shotIsCurrent(guard: PathGuard, paths: WorkspacePaths): boolean {
  const f = screenJpgPath(paths);
  if (!fs.existsSync(guard.assert(f))) return false;
  const stamp = readScreenStamp(paths);
  const capturedAt = readScreenJson(guard, paths)?.captured_at ?? '';
  return Boolean(stamp) && stamp === capturedAt;
}

/**
 * HB-15 (B): drop a screenshot that does not belong to this beat - burn the
 * image and remove its stamp, so nothing downstream can present it as "what you
 * are doing now".
 */
export function dropStaleShot(guard: PathGuard, paths: WorkspacePaths): void {
  burnFileSync(guard.assert(screenJpgPath(paths)));
  fs.rmSync(screenStampPath(paths), { force: true });
}

/**
 * Run the collector and encrypt results into data/screen.json + screen.jpg.
 * Failure degrades gracefully: heartbeat continues with text-only signals.
 */
export async function collectScreen(
  guard: PathGuard,
  paths: WorkspacePaths,
  now = Date.now(),
  /** H-68: `busy-rules.json` → `rules.visible_window_cap`; the collector keeps
   *  its own 20 as the fallback. */
  windowCap = 20,
  signal?: AbortSignal,
): Promise<ScreenPulseSummary> {
  // The collector writes fixed names into outdir (data/tmp); single-flight in
  // the orchestrator prevents concurrent beats from stomping these files.
  const rawJson = path.join(paths.tmpDir, 'screen.raw.json');
  const rawJpg = path.join(paths.tmpDir, 'screen.raw.jpg');
  let encJson = '';
  /** HB-15: only a screenshot encrypted during THIS beat counts as one. */
  let shotThisBeat = false;
  try {
    const r = await runPowerShellFile(
      path.join(paths.assetsDir, 'screenpulse.ps1'),
      ['-outdir', paths.tmpDir, '-cap', String(windowCap)],
      45_000,
      signal,
    );
    // ⑤A: an aborted beat has no use for a fresh pulse, and writing one here
    // would count as a write after cancellation.
    if (signal?.aborted) {
      return { ok: false, capturedAt: null, hasShot: false, visibleCount: 0, error: 'aborted' };
    }
    if (r.status !== 0) {
      // HB-15 (B): the collector failed, so this beat has no picture of its
      // own. Whatever screen.jpg is still on disk belongs to an earlier beat
      // and would be read as the current screen - drop it instead of leaving
      // it to be mistaken for now.
      dropStaleShot(guard, paths);
      return { ok: false, capturedAt: null, hasShot: false, visibleCount: 0, error: `collector exit ${r.status}` };
    }
    const raw = fs.readFileSync(rawJson, 'utf8');
    const meta = JSON.parse(raw) as ScreenJson & { shot_path?: string };
    if (meta.shot_path && fs.existsSync(meta.shot_path)) {
      try {
        // Image first, then its stamp: only when both land is the shot this
        // beat's own. A half-finished pair is dropped right below.
        encryptFile(guard, meta.shot_path, screenJpgPath(paths));
        fs.writeFileSync(
          screenStampPath(paths),
          String(meta.captured_at ?? new Date(now).toISOString()),
          'utf8',
        );
        shotThisBeat = true;
      } catch {
        // shot encryption (or stamping) failure: text signals only
      }
    }
    if (!shotThisBeat) dropStaleShot(guard, paths);
    const { shot_path: _drop, ...clean } = meta;
    void _drop;
    encJson = path.join(paths.tmpDir, `screen.enc.${now}.json`);
    fs.writeFileSync(encJson, JSON.stringify(clean, null, 1), 'utf8');
    encryptFile(guard, encJson, screenJsonPath(paths));
    return {
      ok: true,
      capturedAt: meta.captured_at ?? null,
      hasShot: shotThisBeat,
      visibleCount: Array.isArray(meta.windows) ? meta.windows.length : 0,
    };
  } catch (e) {
    // HB-15 (B): a beat that never produced a complete pulse keeps no picture.
    dropStaleShot(guard, paths);
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
    burnFileSync(tmp);
  }
}

/**
 * "Use then burn": decrypt the screenshot into data/tmp for on-demand
 * analysis. Caller MUST delete the returned path right after use.
 */
export function unlockShot(guard: PathGuard, paths: WorkspacePaths): string | null {
  const f = screenJpgPath(paths);
  // HB-15: refuse anything that is not this beat's shot; returning null keeps
  // vision off rather than describing an old screen as now.
  if (!shotIsCurrent(guard, paths)) return null;
  const tmp = path.join(paths.tmpDir, `screen.view.${Date.now()}.jpg`);
  try {
    decryptFile(guard, f, guard.assert(tmp));
  } catch (e) {
    // H-11: a failed decrypt can still have left a partial plaintext file —
    // burn it before surfacing the error (the caller keeps vision off).
    burnFileSync(tmp);
    throw e;
  }
  return tmp;
}

/** Plaintext screenshot window: burn (not merely unlink) after use (H-59). */
export function burnUnlocked(guard: PathGuard, tmpPath: string): void {
  burnFileSync(guard.assert(tmpPath));
}
