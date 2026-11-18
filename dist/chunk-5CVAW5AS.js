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
var currentDeliveryId = "";
function setCurrentDeliveryId(id) {
  currentDeliveryId = id;
}
function getCurrentDeliveryId() {
  return currentDeliveryId;
}

export {
  setRuntime,
  getRuntime,
  resetRuntimeForTest,
  setCurrentDeliveryId,
  getCurrentDeliveryId
};
//# sourceMappingURL=chunk-5CVAW5AS.js.map