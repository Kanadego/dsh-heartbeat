// src/core/atomic-fs.ts
import fs from "fs";
import path from "path";
import { randomUUID, randomFillSync } from "crypto";
function tmpSibling(target, tag = "w") {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${tag}-${randomUUID().slice(0, 8)}.tmp`
  );
}
function atomicWriteFileSync(target, data) {
  const tmp = tmpSibling(target);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
function atomicWriteJsonSync(target, value) {
  atomicWriteFileSync(target, JSON.stringify(value, null, 2));
}
function shredFileSync(target, passes = 3) {
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error(`shred: not a file: ${target}`);
  const buf = Buffer.alloc(Math.max(stat.size, 1));
  for (let i = 0; i < passes; i++) {
    randomFillSync(buf);
    fs.writeFileSync(target, buf);
  }
  fs.rmSync(target, { force: true });
}
function burnFileSync(target) {
  try {
    shredFileSync(target);
  } catch {
    fs.rmSync(target, { force: true });
  }
}

export {
  atomicWriteFileSync,
  atomicWriteJsonSync,
  shredFileSync,
  burnFileSync
};
//# sourceMappingURL=chunk-WRUTATW4.js.map