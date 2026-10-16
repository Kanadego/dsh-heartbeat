import {
  burnFileSync
} from "./chunk-IBBAISSW.js";

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
var MAGIC_V1 = Buffer.from("KHBV1", "ascii");
var MAGIC_V2 = Buffer.from("KHBV2", "ascii");
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
    const head = Buffer.alloc(MAGIC_V2.length);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    if (read === MAGIC_V1.length && head.subarray(0, MAGIC_V1.length).equals(MAGIC_V1)) return true;
    return read === MAGIC_V2.length && head.equals(MAGIC_V2);
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
  return path2.join(dshHomeDir(env, home), "heartbeat-data");
}
function dshHomeDir(env = process.env, home = os.homedir()) {
  const override = env.DSH_HOME?.trim();
  return override && override.length > 0 ? override : path2.join(home, ".dsh");
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

// src/core/file-lock.ts
import fs3 from "fs";
var STALE_MS = 15e3;
var WAIT_MS = 3e3;
var POLL_MS = 25;
var UNKNOWN_HOLDER_MS = 2 * STALE_MS;
var FileLockTimeoutError = class extends Error {
  target;
  waitedMs;
  constructor(target, waitedMs) {
    super(`file lock timeout after ${waitedMs}ms: ${target}`);
    this.name = "FileLockTimeoutError";
    this.target = target;
    this.waitedMs = waitedMs;
  }
};
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function holderAlive(lock, ageMs) {
  let raw = "";
  try {
    raw = fs3.readFileSync(lock, "utf8");
  } catch {
    return ageMs < UNKNOWN_HOLDER_MS;
  }
  const pid = Number.parseInt(raw.trim().split(/\s+/)[0] ?? "", 10);
  if (!Number.isInteger(pid) || pid <= 0) return ageMs < UNKNOWN_HOLDER_MS;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function tryAcquire(lock) {
  try {
    const fd = fs3.openSync(lock, "wx");
    fs3.writeSync(fd, `${process.pid} ${(/* @__PURE__ */ new Date()).toISOString()}
`);
    fs3.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    try {
      const ageMs = Date.now() - fs3.statSync(lock).mtimeMs;
      if (ageMs > STALE_MS && !holderAlive(lock, ageMs)) {
        fs3.rmSync(lock, { force: true });
        return tryAcquire(lock);
      }
    } catch {
      return tryAcquire(lock);
    }
    return false;
  }
}
function acquire(lock, waitMs) {
  const deadline = Date.now() + waitMs;
  for (; ; ) {
    if (tryAcquire(lock)) return true;
    if (Date.now() >= deadline) return false;
    sleepSync(POLL_MS);
  }
}
function release(lock) {
  try {
    fs3.rmSync(lock, { force: true });
  } catch {
  }
}
function withFileLock(target, fn, opts = {}) {
  const waitMs = opts.waitMs ?? WAIT_MS;
  const lock = `${target}.lock`;
  if (!acquire(lock, waitMs)) throw new FileLockTimeoutError(target, waitMs);
  try {
    return fn();
  } finally {
    release(lock);
  }
}
function tryWithFileLock(target, fn, opts = {}) {
  const waitMs = opts.waitMs ?? WAIT_MS;
  const lock = `${target}.lock`;
  if (!acquire(lock, waitMs)) return null;
  try {
    return fn();
  } finally {
    release(lock);
  }
}

// src/core/fs-walk.ts
import fs4 from "fs";
import path3 from "path";
function matchFilesRecursive(root, match) {
  const re = new RegExp(match.source, match.flags.replace(/g/g, ""));
  const out = [];
  const walk2 = (dir, prefix) => {
    let entries;
    try {
      entries = fs4.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk2(path3.join(dir, e.name), rel);
        continue;
      }
      if (!e.isFile()) continue;
      if (re.test(e.name)) out.push(rel);
    }
  };
  walk2(root, "");
  return out.sort();
}

// src/vault/vault.ts
import fs5 from "fs";
import path4 from "path";
import { spawnSync } from "child_process";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "crypto";
var MAGIC_V12 = Buffer.from("KHBV1", "ascii");
var MAGIC_V22 = Buffer.from("KHBV2", "ascii");
var V2_VERSION = 1;
var V2_NONCE_BYTES = 12;
var V2_TAG_BYTES = 16;
var V2_HEADER_BYTES = MAGIC_V22.length + 1 + V2_NONCE_BYTES + V2_TAG_BYTES;
var V2_AAD = Buffer.concat([MAGIC_V22, Buffer.from([V2_VERSION])]);
var KEY_BYTES = 32;
var KEY_FILE_NAME = "vault.key";
var VAULT_TIMEOUT_MS = 3e4;
var cachedScriptPath = null;
function vaultScriptPath() {
  if (cachedScriptPath) return cachedScriptPath;
  const script = path4.join(workspace().assetsDir, "vault.ps1");
  if (!fs5.existsSync(script)) throw new Error(`vault script missing: ${script}`);
  cachedScriptPath = script;
  return script;
}
function tmpPlainName(target) {
  return path4.join(workspace().tmpDir, `.${path4.basename(target)}.${randomUUID().slice(0, 8)}.plain`);
}
function tmpEncName(target) {
  return path4.join(workspace().tmpDir, `.${path4.basename(target)}.${randomUUID().slice(0, 8)}.enc`);
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
var SCRATCH_STALE_MS = 10 * 6e4;
var scratchSwept = false;
function sweepVaultScratch() {
  if (scratchSwept) return 0;
  scratchSwept = true;
  let burned = 0;
  try {
    const dir = workspace().tmpDir;
    for (const name of fs5.readdirSync(dir)) {
      if (!/\.(plain|enc)$/.test(name)) continue;
      const p = path4.join(dir, name);
      try {
        if (Date.now() - fs5.statSync(p).mtimeMs < SCRATCH_STALE_MS) continue;
      } catch {
        continue;
      }
      burnFileSync(p);
      burned += 1;
    }
  } catch {
  }
  return burned;
}
function containerKind(file) {
  if (!fs5.existsSync(file)) return "plain";
  const fd = fs5.openSync(file, "r");
  try {
    const head = Buffer.alloc(MAGIC_V22.length);
    const read = fs5.readSync(fd, head, 0, head.length, 0);
    if (read === MAGIC_V12.length && head.subarray(0, MAGIC_V12.length).equals(MAGIC_V12)) return "v1";
    if (read === MAGIC_V22.length && head.equals(MAGIC_V22)) return "v2";
    return "plain";
  } finally {
    fs5.closeSync(fd);
  }
}
function isEncrypted(file) {
  return containerKind(file) !== "plain";
}
function encryptBlob(key, plain) {
  const nonce = randomBytes(V2_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(V2_AAD);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC_V22, Buffer.from([V2_VERSION]), nonce, cipher.getAuthTag(), body]);
}
function decryptBlob(key, raw) {
  if (raw.length < V2_HEADER_BYTES) throw new Error("vault: truncated KHBV2 container");
  if (!raw.subarray(0, MAGIC_V22.length).equals(MAGIC_V22)) throw new Error("vault: missing KHBV2 header");
  const version = raw[MAGIC_V22.length];
  if (version !== V2_VERSION) throw new Error(`vault: unsupported KHBV2 version ${version}`);
  const nonceAt = MAGIC_V22.length + 1;
  const tagAt = nonceAt + V2_NONCE_BYTES;
  const bodyAt = tagAt + V2_TAG_BYTES;
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(nonceAt, tagAt));
  decipher.setAAD(Buffer.concat([MAGIC_V22, Buffer.from([version])]));
  decipher.setAuthTag(raw.subarray(tagAt, bodyAt));
  return Buffer.concat([decipher.update(raw.subarray(bodyAt)), decipher.final()]);
}
function legacyUnprotect(guard, file, out) {
  runVault(guard, ["unprotect", "-InFile", file, "-OutFile", out]);
}
function legacyProtect(guard, inFile, out) {
  runVault(guard, ["protect", "-InFile", inFile, "-OutFile", out]);
}
function vaultKeyPath() {
  return path4.join(workspace().dataDir, KEY_FILE_NAME);
}
var cachedMasterKey = null;
function decodeKeyFile(guard, file) {
  const kind = containerKind(file);
  if (kind === "v2") {
    throw new Error(
      `vault: ${file} is an AES container, but the master key cannot be stored AES-encrypted \u2014 restore it from a backup or re-import the data`
    );
  }
  if (kind !== "v1") throw new Error(`vault: ${file} is not a DPAPI container (not a usable master key)`);
  const tmp = tmpPlainName(file);
  try {
    legacyUnprotect(guard, file, tmp);
    const key = fs5.readFileSync(tmp);
    if (key.length !== KEY_BYTES) {
      throw new Error(`vault: master key has ${key.length} bytes, expected ${KEY_BYTES}`);
    }
    return key;
  } finally {
    burnFileSync(tmp);
  }
}
function masterKey(guard) {
  if (cachedMasterKey) return cachedMasterKey;
  sweepVaultScratch();
  const file = guard.assert(vaultKeyPath());
  if (fs5.existsSync(file)) {
    cachedMasterKey = decodeKeyFile(guard, file);
    return cachedMasterKey;
  }
  fs5.mkdirSync(path4.dirname(file), { recursive: true });
  let created;
  try {
    created = withFileLock(file, () => {
      if (fs5.existsSync(file)) return null;
      const plain = tmpPlainName(file);
      const enc = tmpEncName(file);
      try {
        const key = randomBytes(KEY_BYTES);
        fs5.writeFileSync(plain, key);
        legacyProtect(guard, plain, enc);
        const check = tmpPlainName(file);
        try {
          legacyUnprotect(guard, enc, check);
          if (!fs5.readFileSync(check).equals(key)) throw new Error("vault: master key round-trip mismatch");
        } finally {
          burnFileSync(check);
        }
        fs5.renameSync(enc, file);
        return key;
      } finally {
        burnFileSync(plain);
        fs5.rmSync(enc, { force: true });
      }
    });
  } catch (e) {
    if (e instanceof FileLockTimeoutError && fs5.existsSync(file)) {
      cachedMasterKey = decodeKeyFile(guard, file);
      return cachedMasterKey;
    }
    throw e;
  }
  cachedMasterKey = created ?? decodeKeyFile(guard, file);
  return cachedMasterKey;
}
function readContainer(guard, file) {
  const kind = containerKind(file);
  if (kind === "v2") return decryptBlob(masterKey(guard), fs5.readFileSync(file));
  if (kind === "v1") {
    const tmp = tmpPlainName(file);
    try {
      legacyUnprotect(guard, file, tmp);
      return fs5.readFileSync(tmp);
    } finally {
      burnFileSync(tmp);
    }
  }
  return fs5.readFileSync(file);
}
function writeContainer(guard, file, data) {
  const f = guard.assert(file);
  fs5.mkdirSync(path4.dirname(f), { recursive: true });
  const enc = tmpEncName(f);
  try {
    fs5.writeFileSync(enc, encryptBlob(masterKey(guard), data));
    fs5.renameSync(enc, f);
  } finally {
    fs5.rmSync(enc, { force: true });
  }
}
function loadJson(guard, file) {
  const f = guard.assert(file);
  if (!fs5.existsSync(f)) return null;
  if (containerKind(f) === "plain") {
    try {
      return JSON.parse(fs5.readFileSync(f, "utf8"));
    } catch {
      return null;
    }
  }
  return JSON.parse(readContainer(guard, f).toString("utf8"));
}
function saveJson(guard, file, value) {
  writeContainer(guard, file, Buffer.from(JSON.stringify(value, null, 2), "utf8"));
}
function readText(guard, file, fallback = "") {
  const f = guard.assert(file);
  try {
    return fs5.readFileSync(f, "utf8");
  } catch {
    return fallback;
  }
}
function writeText(guard, file, content) {
  const f = guard.assert(file);
  fs5.mkdirSync(path4.dirname(f), { recursive: true });
  const tmp = tmpPlainName(f);
  try {
    fs5.writeFileSync(tmp, content, "utf8");
    fs5.renameSync(tmp, f);
  } finally {
    burnFileSync(tmp);
  }
}
function loadEncryptedText(guard, file) {
  const f = guard.assert(file);
  if (!fs5.existsSync(f)) return null;
  return readContainer(guard, f).toString("utf8");
}
function saveEncryptedText(guard, file, content) {
  writeContainer(guard, file, Buffer.from(content, "utf8"));
}
function encryptFile(guard, inFile, outFile) {
  const inPath = guard.assert(inFile);
  writeContainer(guard, outFile, fs5.readFileSync(inPath));
}
function decryptFile(guard, inFile, outFile) {
  const inPath = guard.assert(inFile);
  const outPath = guard.assert(outFile);
  fs5.mkdirSync(path4.dirname(outPath), { recursive: true });
  const data = readContainer(guard, inPath);
  const tmp = tmpPlainName(outPath);
  try {
    fs5.writeFileSync(tmp, data);
    fs5.renameSync(tmp, outPath);
  } finally {
    burnFileSync(tmp);
  }
}
function upgradeVaultFile(guard, file) {
  const f = guard.assert(file);
  if (containerKind(f) !== "v1") return false;
  const data = readContainer(guard, f);
  writeContainer(guard, f, data);
  return true;
}
function upgradeVaultTree(guard, dataDir) {
  const result = { scanned: 0, upgraded: 0, failed: [] };
  for (const rel of matchFilesRecursive(dataDir, /./)) {
    if (rel === KEY_FILE_NAME || rel.startsWith("tmp/") || rel.startsWith("tmp\\")) continue;
    const abs = path4.join(dataDir, rel.split("/").join(path4.sep));
    try {
      result.scanned += 1;
      if (upgradeVaultFile(guard, abs)) result.upgraded += 1;
    } catch (e) {
      result.failed.push({ file: rel, reason: e.message });
    }
  }
  return result;
}

export {
  dshHomeDir,
  initWorkspace,
  workspace,
  withFileLock,
  tryWithFileLock,
  matchFilesRecursive,
  containerKind,
  isEncrypted,
  vaultKeyPath,
  loadJson,
  saveJson,
  readText,
  writeText,
  loadEncryptedText,
  saveEncryptedText,
  encryptFile,
  decryptFile,
  upgradeVaultTree
};
//# sourceMappingURL=chunk-6S3GQPIW.js.map