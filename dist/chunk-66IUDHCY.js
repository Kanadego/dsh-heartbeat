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
  let fd = null;
  try {
    fd = fs.openSync(tmp, "w");
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, target);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
    fs.rmSync(tmp, { force: true });
  }
}
function atomicWriteJsonSync(target, value) {
  atomicWriteFileSync(target, JSON.stringify(value, null, 2));
}
function exclusiveWriteDirectSync(target, data) {
  const fd = fs.openSync(target, "wx");
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } catch (e) {
    try {
      fs.closeSync(fd);
    } catch {
    }
    try {
      fs.rmSync(target, { force: true });
    } catch {
    }
    throw e;
  }
  fs.closeSync(fd);
}
function atomicCreateFileSync(target, data) {
  const tmp = tmpSibling(target, "x");
  let fd = null;
  try {
    fd = fs.openSync(tmp, "w");
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    try {
      fs.linkSync(tmp, target);
    } catch (e) {
      const code = e.code;
      if (code === "EEXIST") return;
      if (code === "EPERM" || code === "ENOTSUP" || code === "EACCES") {
        exclusiveWriteDirectSync(target, data);
        return;
      }
      throw e;
    }
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
    fs.rmSync(tmp, { force: true });
  }
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
  atomicCreateFileSync,
  shredFileSync,
  burnFileSync
};
//# sourceMappingURL=chunk-66IUDHCY.js.map