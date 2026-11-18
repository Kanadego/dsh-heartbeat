// Runtime singleton shared by all modules after the plugin entry initializes.

import type { PathGuard } from './path-guard.js';
import type { WorkspacePaths } from './paths.js';
import type { Policy } from '../config/schema.js';

export interface HeartbeatRuntime {
  paths: WorkspacePaths;
  guard: PathGuard;
  policy: Policy;
  /** Live UI flags (M7): re-read by the RPC status endpoint for the card. */
  flags: {
    statusbarEnabled(): boolean;
    timeInjectMin(): number;
    idleMode(): boolean;
    /** Token-saver (v1.7.0): pause the whole beat while the user is away. */
    tokenSaver(): boolean;
    /** Vision engine from the plugin config (v2.2.1-native.1): `auto` /
     *  `native` / `modlens`, or '' = follow data/settings/vision.json and then
     *  the built-in default (auto). Re-read on every beat. */
    visionEngine(): string;
    /** 2.3.0 experimental (default off): a silent seed_report concludes the
     *  turn once it has landed. Read on every beat; saved live via config.set.
     *  Optional so older test doubles / hosts without the ref read as false. */
    concludeSilentTurn?(): boolean;
  };
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

// The delivery id of the package whose turn is currently running (2.3.0
// experimental). seed_report is a GLOBAL tool, so without this it cannot tell
// a stale/typo'd id from the id of the package it is answering — and only the
// latter may end the turn. Module-level because the tool is registered once
// and must see the live value; '' means "no delivery turn is open".
let currentDeliveryId = '';

export function setCurrentDeliveryId(id: string): void {
  currentDeliveryId = id;
}

export function getCurrentDeliveryId(): string {
  return currentDeliveryId;
}
