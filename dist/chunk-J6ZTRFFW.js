// src/core/bindings.ts
import fs from "fs";
import path from "path";
function bindingsFilePath(settingsDir) {
  return path.join(settingsDir, "bindings.json");
}
function loadBindings(guard, settingsDir) {
  const file = bindingsFilePath(settingsDir);
  try {
    const raw = JSON.parse(fs.readFileSync(guard.assert(file), "utf8"));
    return { bindings: Array.isArray(raw.bindings) ? raw.bindings : [] };
  } catch {
    return { bindings: [] };
  }
}
function saveBindings(guard, settingsDir, data) {
  const file = guard.assert(bindingsFilePath(settingsDir));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}
function addBinding(guard, settingsDir, sessionId, opts = {}) {
  const data = loadBindings(guard, settingsDir);
  const existing = data.bindings.find((b) => b.sessionId === sessionId);
  if (existing) {
    existing.deliver = opts.deliver ?? existing.deliver;
    existing.observe = opts.observe ?? existing.observe;
    saveBindings(guard, settingsDir, data);
    return existing;
  }
  const binding = {
    sessionId,
    deliver: opts.deliver ?? true,
    observe: opts.observe ?? false,
    addedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  data.bindings.push(binding);
  saveBindings(guard, settingsDir, data);
  return binding;
}
function removeBinding(guard, settingsDir, sessionId) {
  const data = loadBindings(guard, settingsDir);
  const before = data.bindings.length;
  data.bindings = data.bindings.filter((b) => b.sessionId !== sessionId);
  if (data.bindings.length === before) return false;
  saveBindings(guard, settingsDir, data);
  return true;
}
function deliverTargets(data) {
  return data.bindings.filter((b) => b.deliver);
}
function observeTargets(data) {
  return data.bindings.filter((b) => b.observe);
}

export {
  bindingsFilePath,
  loadBindings,
  saveBindings,
  addBinding,
  removeBinding,
  deliverTargets,
  observeTargets
};
//# sourceMappingURL=chunk-J6ZTRFFW.js.map