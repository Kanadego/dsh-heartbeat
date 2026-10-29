import {
  atomicWriteJsonSync
} from "./chunk-IBBAISSW.js";

// src/core/focus-store.ts
import fs from "fs";
import path from "path";
var FOCUS_MIN_MINUTES = 1;
var FOCUS_MAX_MINUTES = 1440;
function focusStatePath(paths) {
  return path.join(paths.dataDir, "focus.json");
}
function readFocusState(guard, paths, now = Date.now()) {
  try {
    const raw = fs.readFileSync(guard.assert(focusStatePath(paths)), "utf8");
    const parsed = JSON.parse(raw);
    const until = Number(parsed.until);
    if (!Number.isFinite(until) || until <= now) return null;
    return {
      until,
      minutes: Number(parsed.minutes) || 0,
      since: Number(parsed.since) || 0,
      via: String(parsed.via ?? "unknown")
    };
  } catch {
    return null;
  }
}
function writeFocusState(guard, paths, minutes, now = Date.now(), via = "cli") {
  const m = Math.max(FOCUS_MIN_MINUTES, Math.min(FOCUS_MAX_MINUTES, Math.floor(minutes)));
  const state = { until: now + m * 6e4, minutes: m, since: now, via };
  atomicWriteJsonSync(guard.assert(focusStatePath(paths)), state);
  return state;
}
function clearFocusState(guard, paths) {
  try {
    const file = guard.assert(focusStatePath(paths));
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}
function resolveFocusUntil(guard, paths, memoryUntil, now = Date.now()) {
  const file = readFocusState(guard, paths, now)?.until ?? 0;
  return Math.max(memoryUntil > now ? memoryUntil : 0, file);
}

export {
  FOCUS_MIN_MINUTES,
  FOCUS_MAX_MINUTES,
  focusStatePath,
  readFocusState,
  writeFocusState,
  clearFocusState,
  resolveFocusUntil
};
//# sourceMappingURL=chunk-LQKOYTRL.js.map