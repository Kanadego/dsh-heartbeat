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
