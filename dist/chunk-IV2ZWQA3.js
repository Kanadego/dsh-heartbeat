// src/core/file-lock.ts
import fs from "fs";
var STALE_MS = 15e3;
var WAIT_MS = 3e3;
var POLL_MS = 25;
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function tryAcquire(lock) {
  try {
    const fd = fs.openSync(lock, "wx");
    fs.writeSync(fd, `${process.pid} ${(/* @__PURE__ */ new Date()).toISOString()}
`);
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > STALE_MS) {
        fs.rmSync(lock, { force: true });
        return tryAcquire(lock);
      }
    } catch {
      return tryAcquire(lock);
    }
    return false;
  }
}
function withFileLock(target, fn) {
  const lock = `${target}.lock`;
  const deadline = Date.now() + WAIT_MS;
  let held = false;
  for (; ; ) {
    if (tryAcquire(lock)) {
      held = true;
      break;
    }
    if (Date.now() >= deadline) break;
    sleepSync(POLL_MS);
  }
  try {
    return fn();
  } finally {
    if (held) {
      try {
        fs.rmSync(lock, { force: true });
      } catch {
      }
    }
  }
}

export {
  withFileLock
};
//# sourceMappingURL=chunk-IV2ZWQA3.js.map