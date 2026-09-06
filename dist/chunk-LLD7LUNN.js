// src/core/paths.ts
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
var resolved = null;
function findPackageRoot(startFile) {
  let dir = path.dirname(path.resolve(startFile));
  for (; ; ) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("package.json not found above " + startFile);
    dir = parent;
  }
}
function packageRoot() {
  return findPackageRoot(fileURLToPath(import.meta.url));
}
function initWorkspace(config = {}) {
  if (resolved) return resolved;
  const root = packageRoot();
  const dataDir = path.resolve(
    process.env.HEARTBEAT_DATA_DIR || config.dataDir || path.join(root, "data")
  );
  const paths = {
    dataDir,
    settingsDir: path.join(dataDir, "settings"),
    logsDir: path.join(dataDir, "logs"),
    tmpDir: path.join(dataDir, "tmp"),
    exportsDir: path.join(dataDir, "exports"),
    packageRoot: root,
    configDir: path.join(root, "config"),
    assetsDir: path.join(root, "assets")
  };
  for (const dir of [
    paths.dataDir,
    paths.settingsDir,
    paths.logsDir,
    paths.tmpDir,
    paths.exportsDir
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  resolved = paths;
  return paths;
}
function workspace() {
  if (!resolved) throw new Error("workspace not initialized: call initWorkspace() first");
  return resolved;
}

// src/vault/vault.ts
import fs2 from "fs";
import path2 from "path";
import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
var MAGIC = Buffer.from("KHBV1", "ascii");
var VAULT_TIMEOUT_MS = 3e4;
var cachedScriptPath = null;
function vaultScriptPath() {
  if (cachedScriptPath) return cachedScriptPath;
  const script = path2.join(workspace().assetsDir, "vault.ps1");
  if (!fs2.existsSync(script)) throw new Error(`vault script missing: ${script}`);
  cachedScriptPath = script;
  return script;
}
function tmpPlainName(target) {
  return path2.join(workspace().tmpDir, `.${path2.basename(target)}.${randomUUID().slice(0, 8)}.plain`);
}
function tmpEncName(target) {
  return path2.join(workspace().tmpDir, `.${path2.basename(target)}.${randomUUID().slice(0, 8)}.enc`);
}
function runVault(guard, args) {
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", vaultScriptPath(), ...args],
    { timeout: VAULT_TIMEOUT_MS, encoding: "utf8" }
  );
  if (r.error) throw new Error(`vault spawn failed: ${String(r.error)}`);
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || "").trim().split("\n").slice(-3).join("; ");
    throw new Error(`vault ${args[0]} failed (exit ${r.status}): ${detail}`);
  }
}
function isEncrypted(file) {
  if (!fs2.existsSync(file)) return false;
  const fd = fs2.openSync(file, "r");
  try {
    const hdr = Buffer.alloc(MAGIC.length);
    const read = fs2.readSync(fd, hdr, 0, hdr.length, 0);
    return read === MAGIC.length && hdr.equals(MAGIC);
  } finally {
    fs2.closeSync(fd);
  }
}
function loadJson(guard, file) {
  const f = guard.assert(file);
  if (!fs2.existsSync(f)) return null;
  if (!isEncrypted(f)) {
    try {
      return JSON.parse(fs2.readFileSync(f, "utf8"));
    } catch {
      return null;
    }
  }
  const tmp = tmpPlainName(f);
  try {
    runVault(guard, ["unprotect", "-InFile", f, "-OutFile", tmp]);
    return JSON.parse(fs2.readFileSync(tmp, "utf8"));
  } finally {
    fs2.rmSync(tmp, { force: true });
  }
}
function saveJson(guard, file, value) {
  const f = guard.assert(file);
  fs2.mkdirSync(path2.dirname(f), { recursive: true });
  const plain = tmpPlainName(f);
  const enc = tmpEncName(f);
  try {
    fs2.writeFileSync(plain, JSON.stringify(value, null, 2), "utf8");
    runVault(guard, ["protect", "-InFile", plain, "-OutFile", enc]);
    fs2.renameSync(enc, f);
  } finally {
    fs2.rmSync(plain, { force: true });
    fs2.rmSync(enc, { force: true });
  }
}
function readText(guard, file, fallback = "") {
  const f = guard.assert(file);
  try {
    return fs2.readFileSync(f, "utf8");
  } catch {
    return fallback;
  }
}
function writeText(guard, file, content) {
  const f = guard.assert(file);
  fs2.mkdirSync(path2.dirname(f), { recursive: true });
  const tmp = tmpPlainName(f);
  try {
    fs2.writeFileSync(tmp, content, "utf8");
    fs2.renameSync(tmp, f);
  } finally {
    fs2.rmSync(tmp, { force: true });
  }
}
function loadEncryptedText(guard, file) {
  const f = guard.assert(file);
  if (!fs2.existsSync(f)) return null;
  if (!isEncrypted(f)) return fs2.readFileSync(f, "utf8");
  const tmp = tmpPlainName(f);
  try {
    runVault(guard, ["unprotect", "-InFile", f, "-OutFile", tmp]);
    return fs2.readFileSync(tmp, "utf8");
  } finally {
    fs2.rmSync(tmp, { force: true });
  }
}
function saveEncryptedText(guard, file, content) {
  const f = guard.assert(file);
  fs2.mkdirSync(path2.dirname(f), { recursive: true });
  const plain = tmpPlainName(f);
  const enc = tmpEncName(f);
  try {
    fs2.writeFileSync(plain, content, "utf8");
    runVault(guard, ["protect", "-InFile", plain, "-OutFile", enc]);
    fs2.renameSync(enc, f);
  } finally {
    fs2.rmSync(plain, { force: true });
    fs2.rmSync(enc, { force: true });
  }
}
function encryptFile(guard, inFile, outFile) {
  const inPath = guard.assert(inFile);
  const outPath = guard.assert(outFile);
  fs2.mkdirSync(path2.dirname(outPath), { recursive: true });
  const enc = tmpEncName(outPath);
  try {
    runVault(guard, ["protect", "-InFile", inPath, "-OutFile", enc]);
    fs2.renameSync(enc, outPath);
  } finally {
    fs2.rmSync(enc, { force: true });
  }
}
function decryptFile(guard, inFile, outFile) {
  const inPath = guard.assert(inFile);
  const outPath = guard.assert(outFile);
  fs2.mkdirSync(path2.dirname(outPath), { recursive: true });
  runVault(guard, ["unprotect", "-InFile", inPath, "-OutFile", outPath]);
}

export {
  initWorkspace,
  loadJson,
  saveJson,
  readText,
  writeText,
  loadEncryptedText,
  saveEncryptedText,
  encryptFile,
  decryptFile
};
//# sourceMappingURL=chunk-LLD7LUNN.js.map