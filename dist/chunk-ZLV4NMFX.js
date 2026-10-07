import {
  atomicWriteFileSync
} from "./chunk-WRUTATW4.js";

// src/core/path-guard.ts
import fs from "fs";
import path from "path";
var PathOutsideWorkspaceError = class extends Error {
  constructor(target, workspace) {
    super(`path outside workspace: "${target}" (workspace: "${workspace}")`);
    this.name = "PathOutsideWorkspaceError";
  }
};
function canonicalize(target) {
  const abs = path.resolve(target);
  try {
    return fs.realpathSync(abs);
  } catch {
    const tail = [];
    let dir = abs;
    for (; ; ) {
      const base = path.basename(dir);
      const parent = path.dirname(dir);
      if (parent === dir) {
        throw new Error(`cannot canonicalize "${target}": no existing ancestor`);
      }
      tail.push(base);
      dir = parent;
      try {
        const realDir = fs.realpathSync(dir);
        return path.join(realDir, ...tail.reverse());
      } catch {
        continue;
      }
    }
  }
}
function isInsideWorkspace(workspaceCanon, targetCanon) {
  const norm = (p) => {
    let n = path.normalize(p).toLowerCase();
    if (!n.endsWith(path.sep)) n += path.sep;
    return n;
  };
  const w = norm(workspaceCanon);
  const t = norm(targetCanon);
  return t === w || t.startsWith(w);
}
function createPathGuard(workspaceDir) {
  const workspace = canonicalize(workspaceDir);
  const guard = {
    workspace,
    check(target) {
      const canon = canonicalize(target);
      return isInsideWorkspace(workspace, canon) ? canon : null;
    },
    assert(target) {
      const canon = guard.check(target);
      if (canon === null) throw new PathOutsideWorkspaceError(target, workspace);
      return canon;
    }
  };
  return guard;
}

// src/config/schema.ts
var HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function fail(msg) {
  throw new Error(`policy: ${msg}`);
}
function assertPolicy(input) {
  if (!isPlainObject(input)) fail("root must be an object");
  const p = input;
  const hb = p.heartbeat;
  if (!isPlainObject(hb)) fail("heartbeat missing");
  if (typeof hb.intervalMin !== "number" || hb.intervalMin < 1 || hb.intervalMin > 1440) {
    fail("heartbeat.intervalMin must be a number in [1, 1440]");
  }
  if (typeof hb.idleMode !== "boolean") fail("heartbeat.idleMode must be boolean");
  if (typeof hb.archiveRotatedHome !== "boolean") fail("heartbeat.archiveRotatedHome must be boolean");
  const g = p.gate;
  if (!isPlainObject(g)) fail("gate missing");
  if (typeof g.maxDailySend !== "number" || g.maxDailySend < 0) fail("gate.maxDailySend must be >= 0");
  if (typeof g.cooldownMinutes !== "number" || g.cooldownMinutes < 0) fail("gate.cooldownMinutes must be >= 0");
  const qh = g.quietHours;
  if (!isPlainObject(qh)) fail("gate.quietHours missing");
  if (typeof qh.start !== "string" || !HHMM.test(qh.start) || typeof qh.end !== "string" || !HHMM.test(qh.end)) {
    fail('gate.quietHours must be {start:"HH:MM", end:"HH:MM"}');
  }
  const b = p.browse;
  if (!isPlainObject(b)) fail("browse missing");
  if (!Array.isArray(b.windows) || b.windows.length === 0) fail("browse.windows must be a non-empty array");
  for (const w of b.windows) {
    if (!isPlainObject(w)) fail("browse.windows entries must be objects");
    if (typeof w.start !== "string" || !HHMM.test(w.start) || typeof w.end !== "string" || !HHMM.test(w.end)) {
      fail('browse.windows entries must be {start:"HH:MM", end:"HH:MM"}');
    }
  }
  if (typeof b.minIntervalHours !== "number" || b.minIntervalHours <= 0) fail("browse.minIntervalHours must be > 0");
  if (typeof b.maxSeedsPerVisit !== "number" || b.maxSeedsPerVisit < 1) fail("browse.maxSeedsPerVisit must be >= 1");
  const s = p.seeds;
  if (!isPlainObject(s)) fail("seeds missing");
  if (typeof s.maxActive !== "number" || s.maxActive < 1) fail("seeds.maxActive must be >= 1");
  if (!isPlainObject(s.ttlDays)) fail("seeds.ttlDays missing");
  for (const k of ["news", "fandom", "scene", "promise"]) {
    if (typeof s.ttlDays[k] !== "number") fail(`seeds.ttlDays.${k} missing`);
  }
  if (typeof s.coldBenchDays !== "number") fail("seeds.coldBenchDays missing");
  if (typeof s.archiveCap !== "number" || s.archiveCap < 1) fail("seeds.archiveCap must be >= 1");
  if (typeof s.retireAfterUsed !== "number" || s.retireAfterUsed < 1) fail("seeds.retireAfterUsed must be >= 1");
  if (!isPlainObject(s.scoreWeights)) fail("seeds.scoreWeights missing");
  const pr = p.profile;
  if (!isPlainObject(pr)) fail("profile missing");
  const c = pr.consolidation;
  if (!isPlainObject(c)) fail("profile.consolidation missing");
  if (typeof c.minIntervalHours !== "number" || typeof c.inboxBacklog !== "number") fail("profile.consolidation fields missing");
  if (typeof pr.partitionCap !== "number" || pr.partitionCap < 1) fail("profile.partitionCap must be >= 1");
  if (typeof pr.maxOpsPerRun !== "number" || pr.maxOpsPerRun < 1) fail("profile.maxOpsPerRun must be >= 1");
  const cc = pr.confidenceCap;
  if (!isPlainObject(cc)) fail("profile.confidenceCap missing");
  if (typeof cc.chat !== "number" || typeof cc.screen !== "number" || typeof cc.browse !== "number") {
    fail("profile.confidenceCap fields missing");
  }
  if (typeof pr.volatileDays !== "number" || pr.volatileDays < 1) fail("profile.volatileDays must be >= 1");
  if (typeof pr.stableLowActivityDays !== "number" || pr.stableLowActivityDays < 1) fail("profile.stableLowActivityDays must be >= 1");
  if (typeof pr.psyEnabled !== "boolean") fail("profile.psyEnabled must be boolean");
  const ob = p.observe;
  if (!isPlainObject(ob)) fail("observe missing");
  if (typeof ob.maxChars !== "number" || ob.maxChars < 20 || ob.maxChars > 2e3) fail("observe.maxChars must be in [20, 2000]");
  if (typeof ob.perBeat !== "number" || ob.perBeat < 1 || ob.perBeat > 100) fail("observe.perBeat must be in [1, 100]");
  if (!isPlainObject(p.weekly)) fail("weekly missing");
  if (typeof p.weekly.enabled !== "boolean") fail("weekly.enabled must be boolean");
  const r = p.retention;
  if (!isPlainObject(r)) fail("retention missing");
  if (typeof r.envPulseHours !== "number" || typeof r.decisionLogDays !== "number") fail("retention fields missing");
}
function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === void 0 ? base : override;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = v === void 0 ? base[k] : deepMerge(base[k], v);
  }
  return out;
}

// src/config/load.ts
import fs2 from "fs";
import path2 from "path";
var USER_POLICY_FILE = "policy.json";
function loadPolicy(guard, configDir, settingsDir) {
  const factoryPath = path2.join(configDir, "policy.json");
  let factoryRaw;
  try {
    factoryRaw = JSON.parse(fs2.readFileSync(factoryPath, "utf8"));
  } catch (e) {
    throw new Error(`factory policy unreadable at ${factoryPath}: ${String(e)}`);
  }
  assertPolicy(factoryRaw);
  const userPath = guard.assert(path2.join(settingsDir, USER_POLICY_FILE));
  let merged = factoryRaw;
  if (fs2.existsSync(userPath)) {
    try {
      const userRaw = JSON.parse(fs2.readFileSync(userPath, "utf8"));
      merged = deepMerge(factoryRaw, userRaw);
    } catch (e) {
      throw new Error(`user policy layer unparseable at ${userPath}: ${String(e)}`);
    }
  }
  assertPolicy(merged);
  return merged;
}
function updateUserPolicy(guard, settingsDir, patch) {
  const userPath = guard.assert(path2.join(settingsDir, USER_POLICY_FILE));
  let user = {};
  try {
    user = JSON.parse(fs2.readFileSync(userPath, "utf8"));
    if (!user || typeof user !== "object" || Array.isArray(user)) user = {};
  } catch {
    user = {};
  }
  const merged = deepMerge(user, patch);
  fs2.mkdirSync(path2.dirname(userPath), { recursive: true });
  atomicWriteFileSync(userPath, JSON.stringify(merged, null, 2) + "\n");
  return merged;
}

// src/core/preset-install.ts
import fs3 from "fs";
import os from "os";
import path3 from "path";
import { fileURLToPath } from "url";
var COMPOSITION_FILE = "agent.cordis.yml";
var METADATA_FILE = "preset.yml";
var BUNDLED_PRESET_ID = "heartbeat";
function bundledPresetDir(moduleUrl, id = BUNDLED_PRESET_ID) {
  let dir;
  try {
    dir = path3.dirname(fileURLToPath(moduleUrl));
  } catch {
    return void 0;
  }
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = path3.join(dir, "assets", "presets", id);
    if (fs3.existsSync(path3.join(candidate, COMPOSITION_FILE))) return candidate;
    const parent = path3.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return void 0;
}
function userPresetRoot(roots) {
  const found = roots?.find(
    (root) => root?.trust === "user" && typeof root.path === "string" && root.path.length > 0
  );
  return found?.path === void 0 ? void 0 : path3.resolve(found.path);
}
function conventionalUserPresetRoot(env = process.env, home = os.homedir()) {
  const override = env.DSH_HOME?.trim();
  const root = override && override.length > 0 ? override : path3.join(home, ".dsh");
  return path3.join(root, ".agent-presets");
}
function installBundledPreset(options) {
  const id = options.id && options.id.length > 0 ? options.id : BUNDLED_PRESET_ID;
  if (options.enabled === false) {
    return { action: "skipped-disabled", id, detail: "installPreset=false" };
  }
  const bundledDir = bundledPresetDir(options.moduleUrl, BUNDLED_PRESET_ID);
  if (id !== BUNDLED_PRESET_ID) {
    return {
      action: "skipped-custom-id",
      id,
      ...bundledDir === void 0 ? {} : { bundledDir },
      detail: `only "${BUNDLED_PRESET_ID}" ships with the plugin; "${id}" is yours to provide`
    };
  }
  if (bundledDir === void 0) {
    return {
      action: "error",
      id,
      detail: "bundled template not found next to the plugin (assets/presets/heartbeat)"
    };
  }
  const root = options.root ?? (options.rosterKnown ? void 0 : conventionalUserPresetRoot());
  if (root === void 0) {
    return {
      action: "skipped-no-root",
      id,
      bundledDir,
      detail: "the roster mounts no user preset root (includeUserRoot=false)"
    };
  }
  const dir = path3.join(root, id);
  const composition = path3.join(dir, COMPOSITION_FILE);
  try {
    if (fs3.existsSync(composition)) {
      if (options.force !== true) {
        const drifted = !sameBytes(composition, path3.join(bundledDir, COMPOSITION_FILE));
        return {
          action: "exists",
          id,
          dir,
          bundledDir,
          detail: drifted ? "kept as-is (differs from the bundled template)" : "kept as-is"
        };
      }
      fs3.copyFileSync(path3.join(bundledDir, COMPOSITION_FILE), composition);
      return {
        action: "restored",
        id,
        dir,
        bundledDir,
        detail: "composition replaced from the bundled template"
      };
    }
    const existed = fs3.existsSync(dir);
    fs3.mkdirSync(dir, { recursive: true });
    fs3.copyFileSync(path3.join(bundledDir, COMPOSITION_FILE), composition);
    const metadata = path3.join(dir, METADATA_FILE);
    if (!fs3.existsSync(metadata)) fs3.copyFileSync(path3.join(bundledDir, METADATA_FILE), metadata);
    return {
      action: existed ? "repaired" : "created",
      id,
      dir,
      bundledDir,
      detail: existed ? "directory existed without a composition file (it occupied the id as a broken row)" : void 0
    };
  } catch (error) {
    return { action: "error", id, dir, bundledDir, detail: String(error).slice(0, 200) };
  }
}
function describeInstall(result) {
  const where = result.dir === void 0 ? "" : ` (${result.dir})`;
  const why = result.detail === void 0 ? "" : ` \u2014 ${result.detail}`;
  return `preset ${result.id} ${result.action}${where}${why}`;
}
function presetStatus(moduleUrl, id = BUNDLED_PRESET_ID, root = conventionalUserPresetRoot()) {
  const dir = path3.join(root, id);
  const bundledDir = bundledPresetDir(moduleUrl, id);
  const installed = fs3.existsSync(path3.join(dir, COMPOSITION_FILE));
  return {
    id,
    dir,
    ...bundledDir === void 0 ? {} : { bundledDir },
    installed,
    compositionMatches: installed && bundledDir !== void 0 && sameBytes(path3.join(dir, COMPOSITION_FILE), path3.join(bundledDir, COMPOSITION_FILE)),
    metadataMatches: bundledDir !== void 0 && fs3.existsSync(path3.join(dir, METADATA_FILE)) && sameBytes(path3.join(dir, METADATA_FILE), path3.join(bundledDir, METADATA_FILE))
  };
}
function sameBytes(left, right) {
  try {
    return fs3.readFileSync(left).equals(fs3.readFileSync(right));
  } catch {
    return false;
  }
}

export {
  createPathGuard,
  deepMerge,
  loadPolicy,
  updateUserPolicy,
  BUNDLED_PRESET_ID,
  userPresetRoot,
  conventionalUserPresetRoot,
  installBundledPreset,
  describeInstall,
  presetStatus
};
//# sourceMappingURL=chunk-ZLV4NMFX.js.map