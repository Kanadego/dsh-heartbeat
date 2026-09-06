// Runtime singleton shared by all modules after the plugin entry initializes.

import type { PathGuard } from './path-guard.js';
import type { WorkspacePaths } from './paths.js';
import type { Policy } from '../config/schema.js';

export interface HeartbeatRuntime {
  paths: WorkspacePaths;
  guard: PathGuard;
  policy: Policy;
}

let runtime: HeartbeatRuntime | null = null;

export function setRuntime(r: HeartbeatRuntime): void {
  runtime = r;
}

export function getRuntime(): HeartbeatRuntime {
  if (!runtime) throw new Error('heartbeat runtime not initialized');
  return runtime;
}

export function resetRuntimeForTest(): void {
  runtime = null;
}
