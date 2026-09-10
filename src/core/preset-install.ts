// Bundled agent-preset installation (contract C13).
//
// Why this exists: the heartbeat agent is created by the host `agents` service,
// which does NOT go through the session-start preset picker. A bare agent joins
// no preset, and dsh-agent-presets states the consequence verbatim — "its tools,
// prompt sections, and skill catalog resolve against the empty global layer" —
// so it cannot even see `web_search`. The preset is therefore not optional, and
// asking the operator to hand-copy two YAML files was the most error-prone step
// of setup. The plugin now materialises its own bundled template in the roster's
// USER root on first run.
//
// Two properties keep that safe:
//   1. An existing preset is NEVER overwritten — the composition file belongs to
//      whoever edited it. Only a missing (or ghost) directory is filled in.
//   2. The target comes from the roster's OWN roots (`agentPresets.roots`,
//      trust === "user") rather than a guessed `~/.dsh`, so `$DSH_HOME` and a
//      configured home are honoured without re-deriving them here.
//
// Timing: dsh-agent-presets re-scans the filesystem on every read
// (`list()` -> `discoverPresets` -> `scanRoot`, no cache), so a directory
// created here is visible to the very next `mount()` — no restart in between.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const COMPOSITION_FILE = 'agent.cordis.yml';
export const METADATA_FILE = 'preset.yml';
/** The template this package ships, in `assets/presets/<id>/`. */
export const BUNDLED_PRESET_ID = 'heartbeat';

/** One entry of the roster's root list (`AgentPresets.roots`). */
export interface PresetRootLike {
  path?: string;
  trust?: string;
}

export type PresetInstallAction =
  | 'exists'
  | 'created'
  | 'repaired'
  | 'restored'
  | 'skipped-disabled'
  | 'skipped-custom-id'
  | 'skipped-no-root'
  | 'error';

export interface PresetInstallResult {
  action: PresetInstallAction;
  id: string;
  /** Where the preset lives (or would live). */
  dir?: string;
  /** Where the bundled template was read from. */
  bundledDir?: string;
  detail?: string;
}

/**
 * Locate the bundled template directory by walking up from a module URL.
 * Works from both entry points (`dist/index.js` and `dist/cli/index.js`) and
 * from the pnpm copy of an installed package.
 */
export function bundledPresetDir(
  moduleUrl: string,
  id: string = BUNDLED_PRESET_ID,
): string | undefined {
  let dir: string;
  try {
    dir = path.dirname(fileURLToPath(moduleUrl));
  } catch {
    return undefined;
  }
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = path.join(dir, 'assets', 'presets', id);
    if (fs.existsSync(path.join(candidate, COMPOSITION_FILE))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** The roster's user-trust root, which is where locally authored presets live. */
export function userPresetRoot(roots?: readonly PresetRootLike[]): string | undefined {
  const found = roots?.find(
    (root) => root?.trust === 'user' && typeof root.path === 'string' && root.path.length > 0,
  );
  return found?.path === undefined ? undefined : path.resolve(found.path);
}

/**
 * `<dshHome>/.agent-presets` derived from the documented precedence
 * (`$DSH_HOME`, then `~/.dsh`). Only used where no roster is available — the
 * plugin itself prefers {@link userPresetRoot}.
 */
export function conventionalUserPresetRoot(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const override = env.DSH_HOME?.trim();
  const root = override && override.length > 0 ? override : path.join(home, '.dsh');
  return path.join(root, '.agent-presets');
}

export interface InstallPresetOptions {
  /** `import.meta.url` of the calling entry point. */
  moduleUrl: string;
  /** Preset id the heartbeat agent will join (config `agentPreset`). */
  id?: string;
  /** User-trust root reported by the roster. */
  root?: string;
  /** True when the roster answered — then an absent user root is a fact, not a guess. */
  rosterKnown?: boolean;
  /** `false` disables the install (config `installPreset`). */
  enabled?: boolean;
  /** Overwrite an existing composition file with the bundled one. */
  force?: boolean;
}

/**
 * Materialise the bundled preset in the roster's user root when it is absent.
 * Never destructive: an existing composition file is kept unless `force`.
 */
export function installBundledPreset(options: InstallPresetOptions): PresetInstallResult {
  const id = options.id && options.id.length > 0 ? options.id : BUNDLED_PRESET_ID;
  if (options.enabled === false) {
    return { action: 'skipped-disabled', id, detail: 'installPreset=false' };
  }
  const bundledDir = bundledPresetDir(options.moduleUrl, BUNDLED_PRESET_ID);
  if (id !== BUNDLED_PRESET_ID) {
    return {
      action: 'skipped-custom-id',
      id,
      ...(bundledDir === undefined ? {} : { bundledDir }),
      detail: `only "${BUNDLED_PRESET_ID}" ships with the plugin; "${id}" is yours to provide`,
    };
  }
  if (bundledDir === undefined) {
    return {
      action: 'error',
      id,
      detail: 'bundled template not found next to the plugin (assets/presets/heartbeat)',
    };
  }
  const root =
    options.root ?? (options.rosterKnown ? undefined : conventionalUserPresetRoot());
  if (root === undefined) {
    return {
      action: 'skipped-no-root',
      id,
      bundledDir,
      detail: 'the roster mounts no user preset root (includeUserRoot=false)',
    };
  }
  const dir = path.join(root, id);
  const composition = path.join(dir, COMPOSITION_FILE);
  try {
    if (fs.existsSync(composition)) {
      if (options.force !== true) {
        const drifted = !sameBytes(composition, path.join(bundledDir, COMPOSITION_FILE));
        return {
          action: 'exists',
          id,
          dir,
          bundledDir,
          detail: drifted ? 'kept as-is (differs from the bundled template)' : 'kept as-is',
        };
      }
      fs.copyFileSync(path.join(bundledDir, COMPOSITION_FILE), composition);
      return {
        action: 'restored',
        id,
        dir,
        bundledDir,
        detail: 'composition replaced from the bundled template',
      };
    }
    const existed = fs.existsSync(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(bundledDir, COMPOSITION_FILE), composition);
    const metadata = path.join(dir, METADATA_FILE);
    // A directory with a composition but no metadata is legal; only fill a void.
    if (!fs.existsSync(metadata)) fs.copyFileSync(path.join(bundledDir, METADATA_FILE), metadata);
    return {
      action: existed ? 'repaired' : 'created',
      id,
      dir,
      bundledDir,
      detail: existed
        ? 'directory existed without a composition file (it occupied the id as a broken row)'
        : undefined,
    };
  } catch (error) {
    return { action: 'error', id, dir, bundledDir, detail: String(error).slice(0, 200) };
  }
}

/** One line suitable for the audit log and `ctx.logger`. */
export function describeInstall(result: PresetInstallResult): string {
  const where = result.dir === undefined ? '' : ` (${result.dir})`;
  const why = result.detail === undefined ? '' : ` — ${result.detail}`;
  return `preset ${result.id} ${result.action}${where}${why}`;
}

export interface PresetStatus {
  id: string;
  dir: string;
  bundledDir?: string;
  installed: boolean;
  compositionMatches: boolean;
  metadataMatches: boolean;
}

/** Read-only inspection for the CLI (`preset status`). */
export function presetStatus(
  moduleUrl: string,
  id: string = BUNDLED_PRESET_ID,
  root: string = conventionalUserPresetRoot(),
): PresetStatus {
  const dir = path.join(root, id);
  const bundledDir = bundledPresetDir(moduleUrl, id);
  const installed = fs.existsSync(path.join(dir, COMPOSITION_FILE));
  return {
    id,
    dir,
    ...(bundledDir === undefined ? {} : { bundledDir }),
    installed,
    compositionMatches:
      installed && bundledDir !== undefined && sameBytes(path.join(dir, COMPOSITION_FILE), path.join(bundledDir, COMPOSITION_FILE)),
    metadataMatches:
      bundledDir !== undefined &&
      fs.existsSync(path.join(dir, METADATA_FILE)) &&
      sameBytes(path.join(dir, METADATA_FILE), path.join(bundledDir, METADATA_FILE)),
  };
}

function sameBytes(left: string, right: string): boolean {
  try {
    return fs.readFileSync(left).equals(fs.readFileSync(right));
  } catch {
    return false;
  }
}
