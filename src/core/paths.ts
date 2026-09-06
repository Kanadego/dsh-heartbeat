// Workspace/data directory resolution and package asset location.
//
// The data dir is the ONLY directory the plugin writes to at runtime
// (requirement 8). Resolution order: env override > plugin config > default
// (packageRoot/data). All fs writes must go through the path guard created
// from this dir (see core/path-guard.ts).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * Resolve and create the workspace layout. Idempotent; must be called once
 * from the plugin entry before any fs write happens.
 */
export function initWorkspace(config: WorkspaceConfigInput = {}): WorkspacePaths {
  if (resolved) return resolved;
  const root = packageRoot();
  const dataDir = path.resolve(
    process.env.HEARTBEAT_DATA_DIR || config.dataDir || path.join(root, 'data'),
  );
  const paths: WorkspacePaths = {
    dataDir,
    settingsDir: path.join(dataDir, 'settings'),
    logsDir: path.join(dataDir, 'logs'),
    tmpDir: path.join(dataDir, 'tmp'),
    exportsDir: path.join(dataDir, 'exports'),
    packageRoot: root,
    configDir: path.join(root, 'config'),
    assetsDir: path.join(root, 'assets'),
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
