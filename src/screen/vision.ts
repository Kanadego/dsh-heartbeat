// Screen vision bridge (spec ①②, 2026-09-18): describe the per-beat
// screenshot through the ModLens CLI (@liustack/modlens), then hand the engine-room agent a
// one-line "我在干嘛" ingredient. Design constraints:
//
//   - ModLens is resolved at RUNTIME from the plugin's own node_modules
//     ancestry (both live under the profile's node_modules) — no absolute
//     path is ever stored; if the package is absent, vision is simply off.
//   - The spawned CLI is the same entry point the bundled skill drives
//     (`main.js -i <img> -o <out>`), so provider config/keys stay in
//     ModLens's own configuration and NEVER touch this plugin.
//   - Privacy (spec ②): when vision fails, callers must not send the image
//     OR the window titles to the engine-room agent; the summary is treated as UNTRUSTED DATA
//     (the image may contain injected text — same discipline as web content).
//   - "Use then burn": the shot is decrypted into data/tmp, fed to the CLI,
//     and both plaintext intermediates are removed in `finally`.
//   - Async spawn only: the CLI may run for tens of seconds; a sync spawn
//     would freeze the host's event loop.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { PathGuard } from '../core/path-guard.js';
import type { WorkspacePaths } from '../core/paths.js';
import { unlockShot, burnUnlocked } from './screenpulse.js';

export const VISION_TIMEOUT_MS = 120_000;
/** the engine-room agent needs one sentence, not a dossier. */
export const VISION_MAX_SUMMARY = 300;

export interface ScreenVision {
  ok: boolean;
  summary: string | null;
  error?: string;
}

/**
 * Locate ModLens's CLI entry (`dist/main.js`) by walking the module
 * resolution graph up from `fromUrl`. Returns null when the package is not
 * installed along that ancestry (vision silently unsupported there).
 */
export function resolveModlensMain(fromUrl: string): string | null {
  try {
    const req = createRequire(fromUrl);
    const pkgJson = req.resolve('@liustack/modlens/package.json');
    const main = path.join(path.dirname(pkgJson), 'dist', 'main.js');
    return fs.existsSync(main) ? main : null;
  } catch {
    return null;
  }
}

type SpawnCli = (
  cmd: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ code: number | null; stderr?: string }>;

const defaultSpawn: SpawnCli = (cmd, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    // stderr is captured (capped) instead of swallowed: ModLens errors name
    // their cause, and without it a failed read is undebuggable (learned
    // 2026-09-18: the silent default channel failed for 97s with exit 1).
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`modlens timeout (${timeoutMs}ms)`));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr: stderr.slice(0, 4000) });
    });
  });

/** Pull the one-line scene summary out of ModLens's JSON output. Lenient:
 *  the exact envelope has shifted between versions (result.summary /
 *  summary / ocr.full_text); anything readable wins. */
export function extractSummary(raw: string): string | null {
  try {
    const obj = JSON.parse(raw) as {
      result?: { summary?: unknown; ocr?: { full_text?: unknown } };
      summary?: unknown;
      ocr?: { full_text?: unknown };
    };
    const pick = (v: unknown): string | null =>
      typeof v === 'string' && v.trim() ? v.trim() : null;
    const summary =
      pick(obj.result?.summary) ??
      pick(obj.summary) ??
      pick(obj.result?.ocr?.full_text) ??
      pick(obj.ocr?.full_text);
    return summary ? summary.slice(0, VISION_MAX_SUMMARY) : null;
  } catch {
    // plain-text output (older builds): use it only if it looks like prose
    const text = raw.trim();
    return text && text.length > 0 && !text.startsWith('{') ? text.slice(0, VISION_MAX_SUMMARY) : null;
  }
}

/** Default provider pin. ModLens's DEFAULT channel resolution tries the
 *  Antigravity CLI login first; when that login is absent every read burns
 *  ~97s and dies with exit 1 (2026-09-18 现场故障). The openai-compatible
 *  provider is what this deployment actually configures, so we pin it and
 *  let data/settings/vision.json override. */
export const DEFAULT_VISION_PROVIDER = 'openai';

/** Optional local overrides (gitignored): { "provider": "...", "prompt": "..." }. */
export interface VisionSettings {
  provider?: string;
  prompt?: string;
}

export function readVisionSettings(guard: PathGuard, paths: WorkspacePaths): VisionSettings {
  try {
    const raw = fs.readFileSync(guard.assert(path.join(paths.settingsDir, 'vision.json')), 'utf8');
    const obj = JSON.parse(raw) as VisionSettings;
    return {
      ...(typeof obj.provider === 'string' && obj.provider.trim() ? { provider: obj.provider.trim() } : {}),
      ...(typeof obj.prompt === 'string' && obj.prompt.trim() ? { prompt: obj.prompt.trim() } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Describe this beat's screenshot. Never throws: any failure yields
 * { ok: false } and the caller must then keep the image AND window titles
 * away from the engine-room agent (spec ②).
 */
export async function describeScreenShot(
  guard: PathGuard,
  paths: WorkspacePaths,
  opts: {
    moduleUrl: string;
    /** Overrides resolution (tests); must exist on disk when given. */
    mainPath?: string;
    spawnCli?: SpawnCli;
    timeoutMs?: number;
    prompt?: string;
    provider?: string;
    settings?: VisionSettings;
  },
): Promise<ScreenVision> {
  const mainJs = opts.mainPath ?? resolveModlensMain(opts.moduleUrl);
  if (!mainJs) return { ok: false, summary: null, error: 'modlens not installed' };
  const shot = unlockShot(guard, paths);
  if (!shot) return { ok: false, summary: null, error: 'no screenshot this beat' };
  const outJson = path.join(paths.tmpDir, `screen.vision.${Date.now()}.json`);
  const spawnCli = opts.spawnCli ?? defaultSpawn;
  const timeoutMs = opts.timeoutMs ?? VISION_TIMEOUT_MS;
  const settings = opts.settings ?? readVisionSettings(guard, paths);
  const provider = opts.provider ?? settings.provider ?? DEFAULT_VISION_PROVIDER;
  try {
    const args = [
      mainJs,
      '-i', shot,
      '-o', outJson,
      // pin the provider: never let ModLens wander into the Antigravity login
      // probe (absent here) — see DEFAULT_VISION_PROVIDER above.
      '-p', provider,
      '--timeout', String(timeoutMs - 5_000),
    ];
    const prompt = opts.prompt ?? settings.prompt;
    if (prompt) args.push('--prompt', prompt);
    const { code, stderr } = await spawnCli(process.execPath, args, timeoutMs);
    if (code !== 0) {
      return { ok: false, summary: null, error: `modlens exit ${code}${stderr ? `: ${stderr.slice(0, 140)}` : ''}` };
    }
    const raw = fs.existsSync(outJson) ? fs.readFileSync(outJson, 'utf8') : '';
    const summary = extractSummary(raw);
    if (!summary) return { ok: false, summary: null, error: 'modlens produced no summary' };
    return { ok: true, summary };
  } catch (e) {
    return { ok: false, summary: null, error: String(e).slice(0, 160) };
  } finally {
    burnUnlocked(guard, shot);
    fs.rmSync(outJson, { force: true });
  }
}
