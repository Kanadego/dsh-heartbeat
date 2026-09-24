// Two-layer policy loading (D3): factory defaults (config/policy.json, read-only)
// + user layer (data/settings/policy.json). Missing user layer is normal; an
// invalid factory file or user layer is fail-closed (throw at startup).

import fs from 'node:fs';
import path from 'node:path';
import type { PathGuard } from '../core/path-guard.js';
import { assertPolicy, deepMerge, type Policy } from './schema.js';

export const USER_POLICY_FILE = 'policy.json';

export function loadPolicy(guard: PathGuard, configDir: string, settingsDir: string): Policy {
  const factoryPath = path.join(configDir, 'policy.json');
  let factoryRaw: unknown;
  try {
    factoryRaw = JSON.parse(fs.readFileSync(factoryPath, 'utf8'));
  } catch (e) {
    throw new Error(`factory policy unreadable at ${factoryPath}: ${String(e)}`);
  }
  assertPolicy(factoryRaw);

  const userPath = guard.assert(path.join(settingsDir, USER_POLICY_FILE));
  let merged: Policy = factoryRaw;
  if (fs.existsSync(userPath)) {
    try {
      const userRaw: unknown = JSON.parse(fs.readFileSync(userPath, 'utf8'));
      merged = deepMerge(factoryRaw, userRaw);
    } catch (e) {
      throw new Error(`user policy layer unparseable at ${userPath}: ${String(e)}`);
    }
  }
  assertPolicy(merged);
  return merged;
}

/**
 * Merge `patch` into the user policy layer (data/settings/policy.json) without
 * touching the factory file. Used by the settings card for policy-backed
 * toggles (psyEnabled, v1.7.0). No full-Policy validation here: the layer is
 * merged over the factory and validated together at the next loadPolicy.
 */
export function updateUserPolicy(guard: PathGuard, settingsDir: string, patch: Record<string, unknown>): Record<string, unknown> {
  const userPath = guard.assert(path.join(settingsDir, USER_POLICY_FILE));
  let user: Record<string, unknown> = {};
  try {
    user = JSON.parse(fs.readFileSync(userPath, 'utf8')) as Record<string, unknown>;
    if (!user || typeof user !== 'object' || Array.isArray(user)) user = {};
  } catch {
    user = {}; // fresh layer
  }
  const merged = deepMerge(user, patch) as Record<string, unknown>;
  fs.mkdirSync(path.dirname(userPath), { recursive: true });
  fs.writeFileSync(userPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}
