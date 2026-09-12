// src/core/runtime.ts
var runtime = null;
function setRuntime(r) {
  runtime = r;
}
function getRuntime() {
  if (!runtime) throw new Error("heartbeat runtime not initialized");
  return runtime;
}
function resetRuntimeForTest() {
  runtime = null;
}

export {
  setRuntime,
  getRuntime,
  resetRuntimeForTest
};
//# sourceMappingURL=chunk-S7PTR42P.js.map