import {
  burnFileSync
} from "./chunk-WRUTATW4.js";

// src/core/paths.ts
import fs2 from "fs";
import os from "os";
import path2 from "path";
import { fileURLToPath } from "url";

// src/core/data-relocate.ts
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
var SKELETON_DIRS = ["settings", "logs", "tmp", "exports"];
var SCRATCH_DIR = "tmp";
var MAGIC = Buffer.from("KHBV1", "ascii");
function hasPayload(dir) {
  if (!fs.existsSync(dir)) return false;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) return true;
    if (!SKELETON_DIRS.includes(entry.name)) return true;
    if (entry.name === SCRATCH_DIR) continue;
    if (fs.readdirSync(path.join(dir, entry.name)).length > 0) return true;
  }
  return false;
}
function walk(dir, prefix = "", out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!prefix && entry.name === SCRATCH_DIR) continue;
      walk(path.join(dir, entry.name), rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out.sort();
}
function copyTree(src, dst) {
  const scratch = path.resolve(path.join(src, SCRATCH_DIR));
  fs.cpSync(src, dst, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    filter: (from) => path.resolve(from) !== scratch
  });
}
function removeTree(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function isEncryptedFile(file) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(MAGIC.length);
    const read = fs.readSync(fd, head, 0, MAGIC.length, 0);
    return read === MAGIC.length && head.equals(MAGIC);
  } finally {
    fs.closeSync(fd);
  }
}
function parsesAsJson(file) {
  if (isEncryptedFile(file)) return true;
  const text = fs.readFileSync(file, "utf8");
  try {
    if (file.endsWith(".jsonl")) {
      for (const line of text.split("\n")) if (line.trim()) JSON.parse(line);
      return true;
    }
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
function verifyTrees(srcDir, dstDir) {
  const problems = [];
  const warnings = [];
  let files = 0;
  let bytes = 0;
  if (!fs.existsSync(dstDir)) {
    return { ok: false, files: 0, bytes: 0, problems: [`copy missing: ${dstDir}`], warnings };
  }
  const expected = walk(srcDir);
  const actual = walk(dstDir);
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  for (const rel of expected) if (!actualSet.has(rel)) problems.push(`missing: ${rel}`);
  for (const rel of actual) if (!expectedSet.has(rel)) problems.push(`unexpected: ${rel}`);
  for (const rel of expected) {
    const from = path.join(srcDir, rel);
    const to = path.join(dstDir, rel);
    if (!fs.existsSync(to)) continue;
    const sizeFrom = fs.statSync(from).size;
    const sizeTo = fs.statSync(to).size;
    files += 1;
    bytes += sizeFrom;
    if (sizeFrom !== sizeTo) {
      problems.push(`size differs: ${rel} (${sizeFrom} -> ${sizeTo})`);
      continue;
    }
    if (sha256(from) !== sha256(to)) {
      problems.push(`content differs: ${rel}`);
      continue;
    }
    if (/\.(json|jsonl)$/i.test(rel) && !parsesAsJson(to)) warnings.push(`unparseable: ${rel}`);
  }
  return { ok: problems.length === 0, files, bytes, problems, warnings };
}
function stamp(now) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
function relocateDataDir(opts) {
  const srcDir = path.resolve(opts.srcDir);
  const dstDir = path.resolve(opts.dstDir);
  if (!fs.existsSync(srcDir)) return { action: "skipped", reason: "source-missing" };
  if (!hasPayload(srcDir)) return { action: "skipped", reason: "no-payload" };
  if (hasPayload(dstDir)) return { action: "skipped", reason: "destination-exists" };
  const suffix = stamp(opts.now ?? Date.now());
  const backupDir = `${srcDir}.bak-relocate-${suffix}`;
  const stagingDir = `${dstDir}.staging-${suffix}`;
  try {
    copyTree(srcDir, backupDir);
  } catch (error) {
    return { action: "failed", stage: "backup", problems: [errorText(error)], backupDir: null };
  }
  try {
    copyTree(srcDir, stagingDir);
  } catch (error) {
    return { action: "failed", stage: "copy", problems: [errorText(error)], backupDir };
  }
  const verified = verifyTrees(srcDir, stagingDir);
  if (!verified.ok) {
    try {
      removeTree(stagingDir);
    } catch {
    }
    return { action: "failed", stage: "verify", problems: verified.problems, backupDir };
  }
  try {
    if (fs.existsSync(dstDir)) removeTree(dstDir);
    fs.renameSync(stagingDir, dstDir);
  } catch (error) {
    try {
      removeTree(stagingDir);
    } catch {
    }
    return { action: "failed", stage: "commit", problems: [errorText(error)], backupDir };
  }
  const leftovers = [];
  try {
    removeTree(srcDir);
  } catch {
    leftovers.push(srcDir);
  }
  try {
    removeTree(backupDir);
  } catch {
    leftovers.push(backupDir);
  }
  return {
    action: "relocated",
    srcDir,
    dstDir,
    backupDir,
    files: verified.files,
    bytes: verified.bytes,
    warnings: verified.warnings,
    leftovers
  };
}

// src/core/paths.ts
var resolved = null;
function findPackageRoot(startFile) {
  let dir = path2.dirname(path2.resolve(startFile));
  for (; ; ) {
    if (fs2.existsSync(path2.join(dir, "package.json"))) return dir;
    const parent = path2.dirname(dir);
    if (parent === dir) throw new Error("package.json not found above " + startFile);
    dir = parent;
  }
}
function packageRoot() {
  return findPackageRoot(fileURLToPath(import.meta.url));
}
function defaultDataDir(env = process.env, home = os.homedir()) {
  const override = env.DSH_HOME?.trim();
  const root = override && override.length > 0 ? override : path2.join(home, ".dsh");
  return path2.join(root, "heartbeat-data");
}
function initWorkspace(config = {}) {
  if (resolved) return resolved;
  const root = packageRoot();
  const explicit = process.env.HEARTBEAT_DATA_DIR || config.dataDir;
  const homeDir = path2.resolve(defaultDataDir());
  const legacyDir = path2.join(root, "data");
  let dataDir;
  let relocation;
  if (explicit) {
    dataDir = path2.resolve(explicit);
  } else if (hasPayload(homeDir)) {
    dataDir = homeDir;
  } else if (hasPayload(legacyDir)) {
    relocation = relocateDataDir({ srcDir: legacyDir, dstDir: homeDir });
    dataDir = relocation.action === "relocated" ? homeDir : legacyDir;
  } else {
    dataDir = homeDir;
  }
  const paths = {
    dataDir,
    settingsDir: path2.join(dataDir, "settings"),
    logsDir: path2.join(dataDir, "logs"),
    tmpDir: path2.join(dataDir, "tmp"),
    exportsDir: path2.join(dataDir, "exports"),
    packageRoot: root,
    configDir: path2.join(root, "config"),
    assetsDir: path2.join(root, "assets"),
    ...relocation ? { relocation } : {}
  };
  for (const dir of [
    paths.dataDir,
    paths.settingsDir,
    paths.logsDir,
    paths.tmpDir,
    paths.exportsDir
  ]) {
    fs2.mkdirSync(dir, { recursive: true });
  }
  resolved = paths;
  return paths;
}
function workspace() {
  if (!resolved) throw new Error("workspace not initialized: call initWorkspace() first");
  return resolved;
}

// src/vault/vault.ts
import fs3 from "fs";
import path3 from "path";
import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
var MAGIC2 = Buffer.from("KHBV1", "ascii");
var VAULT_TIMEOUT_MS = 3e4;
var cachedScriptPath = null;
function vaultScriptPath() {
  if (cachedScriptPath) return cachedScriptPath;
  const script = path3.join(workspace().assetsDir, "vault.ps1");
  if (!fs3.existsSync(script)) throw new Error(`vault script missing: ${script}`);
  cachedScriptPath = script;
  return script;
}
function tmpPlainName(target) {
  return path3.join(workspace().tmpDir, `.${path3.basename(target)}.${randomUUID().slice(0, 8)}.plain`);
}
function tmpEncName(target) {
  return path3.join(workspace().tmpDir, `.${path3.basename(target)}.${randomUUID().slice(0, 8)}.enc`);
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
  if (!fs3.existsSync(file)) return false;
  const fd = fs3.openSync(file, "r");
  try {
    const hdr = Buffer.alloc(MAGIC2.length);
    const read = fs3.readSync(fd, hdr, 0, hdr.length, 0);
    return read === MAGIC2.length && hdr.equals(MAGIC2);
  } finally {
    fs3.closeSync(fd);
  }
}
function loadJson(guard, file) {
  const f = guard.assert(file);
  if (!fs3.existsSync(f)) return null;
  if (!isEncrypted(f)) {
    try {
      return JSON.parse(fs3.readFileSync(f, "utf8"));
    } catch {
      return null;
    }
  }
  const tmp = tmpPlainName(f);
  try {
    runVault(guard, ["unprotect", "-InFile", f, "-OutFile", tmp]);
    return JSON.parse(fs3.readFileSync(tmp, "utf8"));
  } finally {
    burnFileSync(tmp);
  }
}
function saveJson(guard, file, value) {
  const f = guard.assert(file);
  fs3.mkdirSync(path3.dirname(f), { recursive: true });
  const plain = tmpPlainName(f);
  const enc = tmpEncName(f);
  try {
    fs3.writeFileSync(plain, JSON.stringify(value, null, 2), "utf8");
    runVault(guard, ["protect", "-InFile", plain, "-OutFile", enc]);
    fs3.renameSync(enc, f);
  } finally {
    burnFileSync(plain);
    fs3.rmSync(enc, { force: true });
  }
}
function readText(guard, file, fallback = "") {
  const f = guard.assert(file);
  try {
    return fs3.readFileSync(f, "utf8");
  } catch {
    return fallback;
  }
}
function writeText(guard, file, content) {
  const f = guard.assert(file);
  fs3.mkdirSync(path3.dirname(f), { recursive: true });
  const tmp = tmpPlainName(f);
  try {
    fs3.writeFileSync(tmp, content, "utf8");
    fs3.renameSync(tmp, f);
  } finally {
    burnFileSync(tmp);
  }
}
function loadEncryptedText(guard, file) {
  const f = guard.assert(file);
  if (!fs3.existsSync(f)) return null;
  if (!isEncrypted(f)) return fs3.readFileSync(f, "utf8");
  const tmp = tmpPlainName(f);
  try {
    runVault(guard, ["unprotect", "-InFile", f, "-OutFile", tmp]);
    return fs3.readFileSync(tmp, "utf8");
  } finally {
    burnFileSync(tmp);
  }
}
function saveEncryptedText(guard, file, content) {
  const f = guard.assert(file);
  fs3.mkdirSync(path3.dirname(f), { recursive: true });
  const plain = tmpPlainName(f);
  const enc = tmpEncName(f);
  try {
    fs3.writeFileSync(plain, content, "utf8");
    runVault(guard, ["protect", "-InFile", plain, "-OutFile", enc]);
    fs3.renameSync(enc, f);
  } finally {
    burnFileSync(plain);
    fs3.rmSync(enc, { force: true });
  }
}
function encryptFile(guard, inFile, outFile) {
  const inPath = guard.assert(inFile);
  const outPath = guard.assert(outFile);
  fs3.mkdirSync(path3.dirname(outPath), { recursive: true });
  const enc = tmpEncName(outPath);
  try {
    runVault(guard, ["protect", "-InFile", inPath, "-OutFile", enc]);
    fs3.renameSync(enc, outPath);
  } finally {
    fs3.rmSync(enc, { force: true });
  }
}
function decryptFile(guard, inFile, outFile) {
  const inPath = guard.assert(inFile);
  const outPath = guard.assert(outFile);
  fs3.mkdirSync(path3.dirname(outPath), { recursive: true });
  runVault(guard, ["unprotect", "-InFile", inPath, "-OutFile", outPath]);
}

export {
  initWorkspace,
  workspace,
  isEncrypted,
  loadJson,
  saveJson,
  readText,
  writeText,
  loadEncryptedText,
  saveEncryptedText,
  encryptFile,
  decryptFile
};
//# sourceMappingURL=chunk-K5Y6JP2B.js.map