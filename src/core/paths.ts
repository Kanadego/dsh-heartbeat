// Workspace/data directory resolution and package asset location.
//
// The data dir is the ONLY directory the plugin writes to at runtime
// (requirement 8). Resolution order: env override > plugin config > default
// (`$DSH_HOME/heartbeat-data`) — with a legacy fallback to `packageRoot()/data`
// for installs that predate v1.9.2, which is relocated out of the package on
// first sight (issue #2: a reinstall replaced the package dir and took the
// user's data with it). All fs writes must go through the path guard created
// from this dir (see core/path-guard.ts).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasPayload, relocateDataDir, type RelocateResult } from './data-relocate.js';

export interface WorkspacePaths {
  /** Guard boundary and the only writable tree at runtime. */
  dataDir: string;
  settingsDir: string;
  logsDir: string;
  tmpDir: string;
  exportsDir: string;
  /** Package root (where package.json lives). Read-only at runtime. */
  packageRoot: string;
  configDir: string;
  assetsDir: string;
  /**
   * Set only when a legacy package-local data dir was found: the outcome of
   * the one-time relocation. Absent for explicit dirs and fresh installs.
   */
  relocation?: RelocateResult;
}

export interface WorkspaceConfigInput {
  dataDir?: string | null;
}

let resolved: WorkspacePaths | null = null;

/** Walk up from a module file to the directory containing package.json. */
export function findPackageRoot(startFile: string): string {
  let dir = path.dirname(path.resolve(startFile));
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('package.json not found above ' + startFile);
    dir = parent;
  }
}

export function packageRoot(): string {
  return findPackageRoot(fileURLToPath(import.meta.url));
}

/**
 * Default data dir: `$DSH_HOME/heartbeat-data` (or `~/.dsh/heartbeat-data`).
 * Deliberately outside the package tree — reinstalling or upgrading the plugin
 * replaces that directory and must not touch user data (issue #2).
 */
export function defaultDataDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const override = env.DSH_HOME?.trim();
  const root = override && override.length > 0 ? override : path.join(home, '.dsh');
  return path.join(root, 'heartbeat-data');
}

/**
 * Resolve and create the workspace layout. Idempotent; must be called once
 * from the plugin entry before any fs write happens.
 */
export function initWorkspace(config: WorkspaceConfigInput = {}): WorkspacePaths {
  if (resolved) return resolved;
  const root = packageRoot();
  const explicit = process.env.HEARTBEAT_DATA_DIR || config.dataDir;
  const homeDir = path.resolve(defaultDataDir());
  const legacyDir = path.join(root, 'data');
  let dataDir: string;
  let relocation: RelocateResult | undefined;
  if (explicit) {
    // Explicit configuration always wins, and never moves anything.
    dataDir = path.resolve(explicit);
  } else if (hasPayload(homeDir)) {
    // Already on the new home (a previous run, or a reinstall that kept it).
    dataDir = homeDir;
  } else if (hasPayload(legacyDir)) {
    // Pre-v1.9.2 install: the data lived inside the package. Move it out, and
    // keep serving the legacy tree unless the move verified end to end.
    relocation = relocateDataDir({ srcDir: legacyDir, dstDir: homeDir });
    dataDir = relocation.action === 'relocated' ? homeDir : legacyDir;
  } else {
    dataDir = homeDir;
  }
  const paths: WorkspacePaths = {
    dataDir,
    settingsDir: path.join(dataDir, 'settings'),
    logsDir: path.join(dataDir, 'logs'),
    tmpDir: path.join(dataDir, 'tmp'),
    exportsDir: path.join(dataDir, 'exports'),
    packageRoot: root,
    configDir: path.join(root, 'config'),
    assetsDir: path.join(root, 'assets'),
    ...(relocation ? { relocation } : {}),
  };
  // Bootstrap creation happens before the guard exists; creating exactly one
  // directory tree at a known location is the safe window for this.
  for (const dir of [
    paths.dataDir,
    paths.settingsDir,
    paths.logsDir,
    paths.tmpDir,
    paths.exportsDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  resolved = paths;
  return paths;
}

/** Access already-initialized paths. Throws if initWorkspace was not called. */
export function workspace(): WorkspacePaths {
  if (!resolved) throw new Error('workspace not initialized: call initWorkspace() first');
  return resolved;
}

/** Test-only: forget the resolved singleton so a later init re-resolves. */
export function resetWorkspaceForTest(): void {
  resolved = null;
}
