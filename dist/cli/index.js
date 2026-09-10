import {
  activeSeeds,
  addSeed,
  adviseWander,
  appendAuditLine,
  appendEntry,
  archiveSeedById,
  archivedSeeds,
  browseStatus,
  checkWatchlist,
  completeWander,
  createPathGuard,
  ensureRegistered,
  gcPool,
  ledgerFilePath,
  loadInterests,
  loadPolicy,
  loadPool,
  loadProfile,
  loadWatchlist,
  markDone,
  profileFilePath,
  pruneAuditFile,
  readLedger,
  rebuildProfile,
  scanPending,
  seedsFilePath,
  sendNewMessageHint,
  shredFileSync,
  surfaceSeed,
  verifyProfile
} from "../chunk-DR35M42C.js";
import {
  initWorkspace,
  loadEncryptedText,
  writeText
} from "../chunk-LLD7LUNN.js";

// src/cli/index.ts
import { spawn } from "child_process";
import fs2 from "fs";
import os from "os";
import path2 from "path";

// src/vault/burn-list.ts
import fs from "fs";
import path from "path";
var BURN_LIST = [
  { file: "profile.json", note: "\u753B\u50CF\u7269\u5316\u89C6\u56FE" },
  { file: "profile_inbox.jsonl", note: "\u89C2\u5BDF\u6536\u4EF6\u7BB1" },
  { file: "profile_journal.jsonl", note: "\u753B\u50CF\u64CD\u4F5C\u6D41\u6C34" },
  { file: "profile_rhythm.json", note: "\u4F5C\u606F\u805A\u5408\uFF08\u7EAF\u7EDF\u8BA1\uFF09" },
  { file: "screen.json", note: "\u5C4F\u5E55\u5FEB\u7167\uFF08\u52A0\u5BC6\uFF09" },
  { file: "screen.jpg", note: "\u622A\u56FE\uFF08\u52A0\u5BC6\uFF09" },
  { file: "sent.json", note: "\u8868\u8FBE\u8BB0\u5F55\uFF08\u52A0\u5BC6\uFF09" },
  { file: "browse.json", note: "\u6D4F\u89C8\u6D41\u72B6\u6001\uFF08\u52A0\u5BC6\uFF09" },
  { file: "seeds.jsonl", note: "\u7D20\u6750\u6C60\uFF08\u52A0\u5BC6\uFF09" },
  { file: "ledger.md", note: "\u8D26\u672C\uFF08\u660E\u6587\uFF0C\u4EBA\u53EF\u8BFB\u662F\u8BBE\u8BA1\u76EE\u6807\uFF09" },
  { file: "envpulse.json", note: "\u73AF\u5883\u6E29\u5EA6\u8BA1\u5FEB\u7167" },
  { file: "gate.json", note: "\u95F8\u95E8\u8FD0\u884C\u65F6\u8BA1\u6570" },
  { dir: "tmp", note: "\u89E3\u9501\u4E34\u65F6\u6587\u4EF6\uFF08\u5D29\u6E83\u6B8B\u7559\u7684\u89E3\u5BC6\u660E\u6587\u662F\u6700\u8BE5\u70E7\u7684\u4E1C\u897F\uFF09" },
  { dir: "logs", note: "\u5BA1\u8BA1\u4E0E\u51B3\u7B56\u65E5\u5FD7" },
  { dir: "exports", note: "\u5BFC\u51FA\u4EA7\u7269" }
];
var SETTINGS_DIR = "settings";
function planBurn(guard, paths, all = false) {
  const plan = [];
  for (const t of BURN_LIST) {
    const rel = t.file ?? t.dir;
    if (!all && rel === SETTINGS_DIR) continue;
    const abs = path.join(paths.dataDir, rel);
    let exists = false;
    try {
      exists = fs.existsSync(guard.assert(abs));
    } catch {
      exists = false;
    }
    plan.push({ target: t, exists });
  }
  if (all) {
    plan.push({ target: { dir: SETTINGS_DIR, note: "\u7528\u6237\u8BBE\u5B9A\uFF08\u9690\u79C1\u5BAA\u7AE0/\u95F8\u95E8\u53C2\u6570\uFF09\u2014\u2014\u4EC5 --all \u8FDE\u5E26" }, exists: fs.existsSync(paths.settingsDir) });
  }
  return plan;
}
function executeBurn(guard, paths, opts = {}) {
  const burned = [];
  const missing = [];
  const passes = opts.shredPasses ?? 3;
  for (const t of BURN_LIST) {
    const rel = t.file ?? t.dir;
    const abs = path.join(paths.dataDir, rel);
    let absCanon;
    try {
      absCanon = guard.assert(abs);
    } catch {
      missing.push(rel);
      continue;
    }
    if (t.file) {
      if (fs.existsSync(absCanon)) {
        shredFileSync(absCanon, passes);
        burned.push(rel);
      } else {
        missing.push(rel);
      }
    } else if (fs.existsSync(absCanon)) {
      fs.rmSync(absCanon, { recursive: true, force: true });
      burned.push(rel);
    } else {
      missing.push(rel);
    }
  }
  if (opts.all) {
    fs.rmSync(paths.settingsDir, { recursive: true, force: true });
    burned.push(SETTINGS_DIR);
  }
  appendAuditLine(guard.assert(path.join(paths.dataDir, "profile_journal.jsonl")), {
    event: "BURN_EVENT",
    burned: burned.length,
    missing: missing.length,
    settingsPreserved: !opts.all
  });
  return { burned, missing };
}

// src/cli/index.ts
function usage() {
  return [
    "usage: heartbeat <command> [args]",
    "",
    "commands:",
    "  status                            workspace paths + policy summary",
    "  seeds add <text> [--tag t] [--source s] [--topic x] [--confidence n]",
    "  seeds list [--archived]           list active (or archived) seeds",
    "  seeds surface <id>                count a surfacing (rule 1 accounting)",
    "  seeds archive <id>                deliberate retirement (completed)",
    "  seeds gc                          run deterministic eviction rules 1-3",
    "  seeds stats                       pool status JSON",
    "  ledger add <text>                 register an open item",
    "  ledger list [--pending]           list entries",
    "  ledger done <id|substring>        mark an entry done",
    "  ledger open                       open ledger.md in the default editor",
    "  logs cleanup [--dry-run]          apply log retention now",
    "  browse status                     browse state summary (watch + wander)",
    "  browse dry                        wander adjudication with forced noon window",
    "  browse watch                      run watchlist check now (network)",
    "  browse done <focus>               CODE-side registration after a wander visit",
    "  bind list                         list session bindings (D13)",
    "  bind add <sessionId> [--observe]  bind a session (deliver by default)",
    "  bind remove <sessionId>           unbind a session",
    "  sessions list                     enumerate persisted sessions (ids)",
    "  notify check|register|send        toast channel (D12: hint only, no body)",
    "  profile list [--all]              current valid (or all incl. expired) entries",
    "  profile export                    decrypted Markdown export to data/exports/",
    "  profile verify                    journal replay vs disk (report only)",
    "  profile rebuild [--check]         rebuild materialized view from journal",
    "  profile wipe                      wipe profile data (asks --yes)",
    "  burn [--yes] [--all]              shred runtime data (settings kept unless --all)"
  ].join("\n");
}
function readStdinText() {
  try {
    return fs2.readFileSync(0, "utf8").trim();
  } catch {
    return "";
  }
}
function flag(argv, name) {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : void 0;
}
async function main(argv) {
  const [cmd, sub, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(usage());
    return 0;
  }
  const paths = initWorkspace();
  const guard = createPathGuard(paths.dataDir);
  const policy = loadPolicy(guard, paths.configDir, paths.settingsDir);
  const seedsFile = seedsFilePath(paths.dataDir);
  const ledgerFile = ledgerFilePath(paths.dataDir);
  const decisionLog = path2.join(paths.logsDir, "heartbeat.jsonl");
  switch (cmd) {
    case "status": {
      console.log(JSON.stringify({
        dataDir: paths.dataDir,
        heartbeatIntervalMin: policy.heartbeat.intervalMin,
        maxDailySend: policy.gate.maxDailySend,
        seedsMaxActive: policy.seeds.maxActive,
        psyEnabled: policy.profile.psyEnabled
      }, null, 2));
      return 0;
    }
    case "seeds": {
      switch (sub) {
        case "add": {
          let text = rest[0]?.trim() ?? "";
          if (text === "-") text = readStdinText();
          if (!text) {
            console.error("usage: seeds add <text|-> [--tag t] [--source s] [--topic x] [--confidence n]");
            return 1;
          }
          const result = addSeed(guard, seedsFile, policy, {
            text,
            tag: flag(rest, "--tag"),
            source: flag(rest, "--source"),
            topic: flag(rest, "--topic"),
            confidence: flag(rest, "--confidence") ? Number(flag(rest, "--confidence")) : void 0
          });
          if (result.kind === "duplicate") {
            console.log(`DUPLICATE: active seed ${result.seed.id} has the same text`);
            return 0;
          }
          console.log(`${result.kind.toUpperCase()} ${result.seed.id} (${activeSeeds(loadPool(guard, seedsFile)).length}/${policy.seeds.maxActive})` + (result.evicted ? ` [evicted ${result.evicted.id}: ${result.evicted.retireReason}]` : ""));
          return 0;
        }
        case "list": {
          const db = loadPool(guard, seedsFile);
          const items = rest.includes("--archived") ? archivedSeeds(db) : activeSeeds(db);
          for (const s of items) {
            const ageDays = Math.floor((Date.now() - Date.parse(s.bornAt)) / 864e5);
            console.log(`${s.id} [${s.tag}/${s.source}] d${ageDays} used:${s.used}${s.protected ? " *" : ""} ${s.text.slice(0, 60)}`);
          }
          if (items.length === 0) console.log("(empty)");
          return 0;
        }
        case "surface": {
          const s = surfaceSeed(guard, seedsFile, policy, rest[0] ?? "");
          if (!s) {
            console.log("NOT_FOUND");
            return 1;
          }
          console.log(`SURFACED ${s.id} used:${s.used}${s.status === "archived" ? " -> archived (consumed)" : ""}`);
          return 0;
        }
        case "archive": {
          const s = archiveSeedById(guard, seedsFile, rest[0] ?? "");
          if (!s) {
            console.log("NOT_FOUND");
            return 1;
          }
          console.log(`ARCHIVED ${s.id}`);
          return 0;
        }
        case "gc": {
          const report = gcPool(guard, seedsFile, policy);
          console.log(`GC consumed:${report.consumed} expired:${report.expired} cold_bench:${report.coldBench} -> active ${report.activeAfter}/${policy.seeds.maxActive}`);
          return 0;
        }
        case "stats": {
          const db = loadPool(guard, seedsFile);
          console.log(JSON.stringify({
            active: activeSeeds(db).length,
            archived: archivedSeeds(db).length,
            cap: policy.seeds.maxActive,
            seq: db.seq
          }, null, 2));
          return 0;
        }
        default:
          console.error(`unknown seeds subcommand: ${sub}`);
          return 1;
      }
    }
    case "ledger": {
      switch (sub) {
        case "add": {
          let text = rest.join(" ").trim();
          if (text === "-") text = readStdinText();
          if (!text) {
            console.error("usage: ledger add <text|->");
            return 1;
          }
          const e = appendEntry(guard, ledgerFile, text);
          console.log(`OPEN #${e.id} ${e.text.slice(0, 60)}`);
          return 0;
        }
        case "list": {
          const { entries } = readLedger(guard, ledgerFile);
          const items = rest.includes("--pending") ? scanPending(guard, ledgerFile) : entries;
          for (const e of items) console.log(`${e.status === "open" ? " " : "x"} #${e.id} ${e.date} ${e.text.slice(0, 60)}`);
          if (items.length === 0) console.log("(empty)");
          return 0;
        }
        case "done": {
          const key = rest.join(" ").trim();
          if (!key) {
            console.error("usage: ledger done <id|substring>");
            return 1;
          }
          const e = markDone(guard, ledgerFile, key);
          if (!e) {
            console.log("NOT_FOUND");
            return 1;
          }
          console.log(`DONE #${e.id}`);
          return 0;
        }
        case "open": {
          const f = ledgerFile;
          if (!fs2.existsSync(f)) {
            console.log(`(ledger will be created at ${f})`);
          }
          spawn("cmd", ["/c", "start", "", f], { detached: true, stdio: "ignore" }).unref();
          console.log(`opened ${f}`);
          return 0;
        }
        default:
          console.error(`unknown ledger subcommand: ${sub}`);
          return 1;
      }
    }
    case "logs": {
      if (sub !== "cleanup") {
        console.error("usage: logs cleanup [--dry-run]");
        return 1;
      }
      const dry = rest.includes("--dry-run");
      const envPulse = path2.join(paths.logsDir, "envpulse.jsonl");
      const cut1 = policy.retention.envPulseHours * 36e5;
      const cut2 = policy.retention.decisionLogDays * 864e5;
      if (dry) {
        console.log(`(dry-run) would prune ${envPulse} to ${policy.retention.envPulseHours}h and ${decisionLog} to ${policy.retention.decisionLogDays}d`);
        return 0;
      }
      const a = pruneAuditFile(envPulse, cut1);
      const b = pruneAuditFile(decisionLog, cut2);
      appendAuditLine(decisionLog, { event: "retention", pruned_envpulse: a, pruned_decision: b });
      console.log(`PRUNED envpulse:${a} decision:${b}`);
      return 0;
    }
    case "browse": {
      switch (sub) {
        case "status": {
          const st = browseStatus(guard, paths);
          const interests = loadInterests(paths);
          console.log(JSON.stringify({
            watchTargets: loadWatchlist(paths).targets?.length ?? 0,
            lastCheckAt: st.last_check_at ? new Date(st.last_check_at).toISOString() : null,
            lastWanderAt: st.wander.last_wander_at ? new Date(st.wander.last_wander_at).toISOString() : null,
            focusCount: st.wander.focusCount,
            interestCount: interests.interests?.length ?? 0
          }, null, 2));
          return 0;
        }
        case "dry": {
          const forced = /* @__PURE__ */ new Date();
          forced.setHours(12, 0, 0, 0);
          const advice = adviseWander(guard, paths, policy, forced);
          console.log(JSON.stringify(advice, null, 2));
          return 0;
        }
        case "watch": {
          const report = await checkWatchlist(guard, paths, { throttleOk: true });
          console.log(JSON.stringify({ checked: report.checked, updates: report.items.length, errors: report.errors }, null, 2));
          for (const item of report.items) console.log(`NEWS: ${item.text}`);
          return 0;
        }
        case "done": {
          const focus = rest.join(" ").trim();
          if (!focus) {
            console.error("usage: browse done <focus>");
            return 1;
          }
          const r = completeWander(guard, paths, focus);
          console.log(JSON.stringify(r));
          return 0;
        }
        default:
          console.error(`unknown browse subcommand: ${sub}`);
          return 1;
      }
    }
    case "notify": {
      switch (sub) {
        case "check":
          console.log(ensureRegistered(paths) ? "REGISTERED: yes" : "REGISTERED: no");
          return 0;
        case "register":
          ensureRegistered(paths);
          console.log("register attempted");
          return 0;
        case "send":
          console.log(sendNewMessageHint(paths) ? "SENT" : "FAILED");
          return 0;
        default:
          console.error("usage: notify check|register|send");
          return 1;
      }
    }
    case "profile": {
      const doc = loadProfile(guard, profileFilePath(paths.dataDir));
      const all = rest.includes("--all");
      switch (sub) {
        case "list": {
          let n = 0;
          for (const p of ["interest", "projects", "comm", "psy"]) {
            for (const e of doc.partitions[p].entries) {
              if (!all && e.validTo !== null) continue;
              n += 1;
              console.log(`${e.id} [${e.partition}/${e.topic}/${e.subTopic}] ${e.temporal} conf=${e.confidence.toFixed(2)}${e.lowActivity ? " \u4E45\u672A\u9A8C\u8BC1" : ""}${e.validTo ? " [\u5931\u6548]" : ""}: ${e.content.slice(0, 60)}`);
            }
          }
          if (n === 0) console.log("(empty)");
          return 0;
        }
        case "export": {
          const lines = [`# \u753B\u50CF\u5BFC\u51FA ${(/* @__PURE__ */ new Date()).toISOString()}`, ""];
          for (const p of ["interest", "projects", "comm", "psy"]) {
            lines.push(`## ${p}`);
            for (const e of doc.partitions[p].entries) {
              if (e.validTo !== null) continue;
              lines.push(`- [${e.topic}/${e.subTopic}] ${e.content} (conf ${e.confidence.toFixed(2)}, ${e.temporal})`);
            }
          }
          const out = path2.join(paths.exportsDir, `profile-export-${Date.now()}.md`);
          writeText(guard, out, lines.join("\n") + "\n");
          console.log(`EXPORTED: ${out}`);
          return 0;
        }
        case "verify": {
          const r = verifyProfile(guard, paths.dataDir);
          console.log(JSON.stringify(r, null, 2));
          return r.ok ? 0 : 1;
        }
        case "rebuild": {
          const r = rebuildProfile(guard, paths.dataDir, { check: rest.includes("--check") });
          console.log(JSON.stringify(r, null, 2));
          return r.ok ? 0 : 1;
        }
        case "wipe": {
          if (!rest.includes("--yes")) {
            console.log("REFUSED: add --yes to wipe profile data (profile.json/inbox/journal)");
            return 1;
          }
          for (const f of ["profile.json", "profile_inbox.jsonl", "profile_journal.jsonl"]) {
            const abs = guard.assert(path2.join(paths.dataDir, f));
            if (fs2.existsSync(abs)) fs2.rmSync(abs, { force: true });
          }
          console.log("WIPED (settings preserved; use burn for full shredding)");
          return 0;
        }
        default:
          console.error(`unknown profile subcommand: ${sub}`);
          return 1;
      }
    }
    case "burn": {
      const yes = rest.includes("--yes");
      const all = rest.includes("--all");
      const plan = planBurn(guard, paths, all);
      console.log("\u9884\u6F14\uFF08\u4E0D\u4F1A\u6267\u884C\uFF09:");
      for (const p of plan) console.log(`  [${p.exists ? "\u5B58\u5728" : "\u65E0  "}] ${p.target.file ?? p.target.dir}  ${p.target.note}`);
      if (!yes) {
        console.log("\n\u6B64\u64CD\u4F5C\u4F1A\u8BA9\u5FC3\u8DF3 agent \u5931\u5FC6\u3002\u786E\u8BA4\u6267\u884C\u8BF7\u52A0 --yes\uFF08" + (all ? "\u542B --all \u8FDE\u7528\u6237\u8BBE\u5B9A" : "\u7528\u6237\u8BBE\u5B9A\u4FDD\u7559") + "\uFF09");
        return 0;
      }
      const result = executeBurn(guard, paths, { all });
      console.log(`BURNED: ${result.burned.length} \u9879\uFF1BMISSING: ${result.missing.length} \u9879`);
      return 0;
    }
    case "sessions": {
      const root = path2.join(os.homedir(), ".dsh", "sessions");
      let found = 0;
      if (fs2.existsSync(root)) {
        let own = null;
        try {
          own = JSON.parse(loadEncryptedText(guard, path2.join(paths.dataDir, "gate.json")) ?? "{}").sessionId ?? null;
        } catch {
        }
        for (const slug of fs2.readdirSync(root)) {
          for (const id of fs2.readdirSync(path2.join(root, slug))) {
            found += 1;
            const mark = id === own ? "  \u2190 \u5FC3\u8DF3\u6B63\u8EAB" : "";
            console.log(`${id}  [${slug}]${mark}`);
          }
        }
      }
      if (found === 0) console.log("(no persisted sessions found)");
      return 0;
    }
    case "bind": {
      const { loadBindings, addBinding, removeBinding, bindingsFilePath } = await import("../bindings-XPPSKILN.js");
      switch (sub) {
        case "list": {
          const data = loadBindings(guard, paths.settingsDir);
          let own = null;
          try {
            own = JSON.parse(loadEncryptedText(guard, path2.join(paths.dataDir, "gate.json")) ?? "{}").sessionId ?? null;
          } catch {
          }
          if (own) console.log(`\u5FC3\u8DF3\u6B63\u8EAB: ${own}\uFF08\u51B3\u7B56\u8F6E\u6B21\u53D1\u751F\u5730\uFF1Bbind remove \u5B83 = \u91CD\u7F6E\u6B63\u8EAB\uFF09`);
          for (const b of data.bindings) {
            console.log(`${b.sessionId}  deliver:${b.deliver ? "\u221A" : "\xD7"} observe:${b.observe ? "\u221A" : "\xD7"}`);
          }
          if (data.bindings.length === 0 && !own) console.log("(no bindings \u2014 expressions stay in the dedicated heartbeat session)");
          return 0;
        }
        case "add": {
          const id = rest[0];
          if (!id || !id.startsWith("session-")) {
            console.error("usage: bind add <sessionId> [--observe] [--no-deliver]  (see: sessions list)");
            return 1;
          }
          const observe = rest.includes("--observe") || rest.includes("--observe-only");
          const deliver = !rest.includes("--no-deliver") && !rest.includes("--observe-only");
          const b = addBinding(guard, paths.settingsDir, id, { deliver, observe });
          console.log(`BOUND ${b.sessionId} deliver:${b.deliver} observe:${b.observe}`);
          return 0;
        }
        case "remove": {
          const id = rest[0];
          if (!id) {
            console.error("usage: bind remove <sessionId>");
            return 1;
          }
          console.log(removeBinding(guard, paths.settingsDir, id) ? `UNBOUND ${id}` : "NOT_FOUND");
          try {
            const state = JSON.parse(loadEncryptedText(guard, path2.join(paths.dataDir, "gate.json")) ?? "{}");
            if (state.sessionId === id) {
              fs2.rmSync(guard.assert(path2.join(paths.dataDir, "gate.json")), { force: true });
              console.log("\u6CE8\u610F\uFF1A\u8FD9\u662F\u5FC3\u8DF3\u6B63\u8EAB\u4F1A\u8BDD\u3002\u5DF2\u91CD\u7F6E\u2014\u2014\u4E0B\u6B21\u5FC3\u8DF3\u5C06\u521B\u5EFA\u65B0\u7684\u6B63\u8EAB\u4F1A\u8BDD\uFF08\u65E7\u4F1A\u8BDD\u4E0D\u518D\u6709\u5FC3\u8DF3\uFF09");
              appendAuditLine(paths.logsDir + "/heartbeat.jsonl", { event: "home_reset", oldSessionId: id });
            }
          } catch {
          }
          return 0;
        }
        default:
          console.error("usage: bind list | add <sessionId> | remove <sessionId>");
          return 1;
      }
    }
    default:
      console.error(`unknown command: ${cmd}`);
      console.log(usage());
      return 1;
  }
}
if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
export {
  main
};
//# sourceMappingURL=index.js.map