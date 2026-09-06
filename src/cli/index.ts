// Operational CLI (design doc §14). Commands grow per module.
// Run: node dist/cli/index.js <command> [args]  (or via tsx in dev)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initWorkspace, workspace } from '../core/paths.js';
import { createPathGuard } from '../core/path-guard.js';
import { appendAuditLine, pruneAuditFile } from '../core/audit-log.js';
import { loadEncryptedText } from '../vault/vault.js';
import { loadPolicy } from '../config/load.js';
import {
  addSeed,
  archiveSeedById,
  gcPool,
  loadPool,
  activeSeeds,
  archivedSeeds,
  seedsFilePath,
  surfaceSeed,
} from '../seeds/pool.js';
import {
  appendEntry,
  ledgerFilePath,
  markDone,
  readLedger,
  scanPending,
} from '../ledger/ledger.js';
import {
  adviseWander,
  browseStatePath,
  browseStatus,
  checkWatchlist,
  completeWander,
  loadInterests,
  loadWatchlist,
} from '../browse/browse.js';
import { ensureRegistered, sendNewMessageHint } from '../notify/notify.js';
import {
  loadProfile,
  profileFilePath,
  verifyProfile,
  rebuildProfile,
} from '../profile/store.js';
import { loadProfileSchema } from '../profile/schema.js';
import { planBurn, executeBurn } from '../vault/burn-list.js';
import { writeText } from '../vault/vault.js';

function usage(): string {
  return [
    'usage: heartbeat <command> [args]',
    '',
    'commands:',
    '  status                            workspace paths + policy summary',
    '  seeds add <text> [--tag t] [--source s] [--topic x] [--confidence n]',
    '  seeds list [--archived]           list active (or archived) seeds',
    '  seeds surface <id>                count a surfacing (rule 1 accounting)',
    '  seeds archive <id>                deliberate retirement (completed)',
    '  seeds gc                          run deterministic eviction rules 1-3',
    '  seeds stats                       pool status JSON',
    '  ledger add <text>                 register an open item',
    '  ledger list [--pending]           list entries',
    '  ledger done <id|substring>        mark an entry done',
    '  ledger open                       open ledger.md in the default editor',
    '  logs cleanup [--dry-run]          apply log retention now',
    '  browse status                     browse state summary (watch + wander)',
    '  browse dry                        wander adjudication with forced noon window',
    '  browse watch                      run watchlist check now (network)',
    '  browse done <focus>               CODE-side registration after a wander visit',
    '  bind list                         list session bindings (D13)',
    '  bind add <sessionId> [--observe]  bind a session (deliver by default)',
    '  bind remove <sessionId>           unbind a session',
    '  sessions list                     enumerate persisted sessions (ids)',
    '  notify check|register|send        toast channel (D12: hint only, no body)',
    '  profile list [--all]              current valid (or all incl. expired) entries',
    '  profile export                    decrypted Markdown export to data/exports/',
    '  profile verify                    journal replay vs disk (report only)',
    '  profile rebuild [--check]         rebuild materialized view from journal',
    '  profile wipe                      wipe profile data (asks --yes)',
    '  burn [--yes] [--all]              shred runtime data (settings kept unless --all)',
  ].join('\n');
}

function readStdinText(): string {
  try {
    return fs.readFileSync(0, 'utf8').trim();
  } catch {
    return '';
  }
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : undefined;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, sub, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(usage());
    return 0;
  }
  const paths = initWorkspace();
  const guard = createPathGuard(paths.dataDir);
  const policy = loadPolicy(guard, paths.configDir, paths.settingsDir);
  const seedsFile = seedsFilePath(paths.dataDir);
  const ledgerFile = ledgerFilePath(paths.dataDir);
  const decisionLog = path.join(paths.logsDir, 'heartbeat.jsonl');

  switch (cmd) {
    case 'status': {
      console.log(JSON.stringify({
        dataDir: paths.dataDir,
        heartbeatIntervalMin: policy.heartbeat.intervalMin,
        maxDailySend: policy.gate.maxDailySend,
        seedsMaxActive: policy.seeds.maxActive,
        psyEnabled: policy.profile.psyEnabled,
      }, null, 2));
      return 0;
    }

    case 'seeds': {
      switch (sub) {
        case 'add': {
          let text = rest[0]?.trim() ?? '';
          if (text === '-') text = readStdinText();
          if (!text) {
            console.error('usage: seeds add <text|-> [--tag t] [--source s] [--topic x] [--confidence n]');
            return 1;
          }
          const result = addSeed(guard, seedsFile, policy, {
            text,
            tag: flag(rest, '--tag') as never,
            source: flag(rest, '--source') as never,
            topic: flag(rest, '--topic'),
            confidence: flag(rest, '--confidence') ? Number(flag(rest, '--confidence')) : undefined,
          });
          if (result.kind === 'duplicate') {
            console.log(`DUPLICATE: active seed ${result.seed.id} has the same text`);
            return 0;
          }
          console.log(`${result.kind.toUpperCase()} ${result.seed.id}` +
            ` (${activeSeeds(loadPool(guard, seedsFile)).length}/${policy.seeds.maxActive})` +
            (result.evicted ? ` [evicted ${result.evicted.id}: ${result.evicted.retireReason}]` : ''));
          return 0;
        }
        case 'list': {
          const db = loadPool(guard, seedsFile);
          const items = rest.includes('--archived') ? archivedSeeds(db) : activeSeeds(db);
          for (const s of items) {
            const ageDays = Math.floor((Date.now() - Date.parse(s.bornAt)) / 86_400_000);
            console.log(`${s.id} [${s.tag}/${s.source}] d${ageDays} used:${s.used}` +
              `${s.protected ? ' *' : ''} ${s.text.slice(0, 60)}`);
          }
          if (items.length === 0) console.log('(empty)');
          return 0;
        }
        case 'surface': {
          const s = surfaceSeed(guard, seedsFile, policy, rest[0] ?? '');
          if (!s) {
            console.log('NOT_FOUND');
            return 1;
          }
          console.log(`SURFACED ${s.id} used:${s.used}${s.status === 'archived' ? ' -> archived (consumed)' : ''}`);
          return 0;
        }
        case 'archive': {
          const s = archiveSeedById(guard, seedsFile, rest[0] ?? '');
          if (!s) {
            console.log('NOT_FOUND');
            return 1;
          }
          console.log(`ARCHIVED ${s.id}`);
          return 0;
        }
        case 'gc': {
          const report = gcPool(guard, seedsFile, policy);
          console.log(`GC consumed:${report.consumed} expired:${report.expired} cold_bench:${report.coldBench}` +
            ` -> active ${report.activeAfter}/${policy.seeds.maxActive}`);
          return 0;
        }
        case 'stats': {
          const db = loadPool(guard, seedsFile);
          console.log(JSON.stringify({
            active: activeSeeds(db).length,
            archived: archivedSeeds(db).length,
            cap: policy.seeds.maxActive,
            seq: db.seq,
          }, null, 2));
          return 0;
        }
        default:
          console.error(`unknown seeds subcommand: ${sub}`);
          return 1;
      }
    }

    case 'ledger': {
      switch (sub) {
        case 'add': {
          let text = rest.join(' ').trim();
          if (text === '-') text = readStdinText();
          if (!text) {
            console.error('usage: ledger add <text|->');
            return 1;
          }
          const e = appendEntry(guard, ledgerFile, text);
          console.log(`OPEN #${e.id} ${e.text.slice(0, 60)}`);
          return 0;
        }
        case 'list': {
          const { entries } = readLedger(guard, ledgerFile);
          const items = rest.includes('--pending') ? scanPending(guard, ledgerFile) : entries;
          for (const e of items) console.log(`${e.status === 'open' ? ' ' : 'x'} #${e.id} ${e.date} ${e.text.slice(0, 60)}`);
          if (items.length === 0) console.log('(empty)');
          return 0;
        }
        case 'done': {
          const key = rest.join(' ').trim();
          if (!key) {
            console.error('usage: ledger done <id|substring>');
            return 1;
          }
          const e = markDone(guard, ledgerFile, key);
          if (!e) {
            console.log('NOT_FOUND');
            return 1;
          }
          console.log(`DONE #${e.id}`);
          return 0;
        }
        case 'open': {
          const f = ledgerFile;
          if (!fs.existsSync(f)) {
            console.log(`(ledger will be created at ${f})`);
          }
          spawn('cmd', ['/c', 'start', '', f], { detached: true, stdio: 'ignore' }).unref();
          console.log(`opened ${f}`);
          return 0;
        }
        default:
          console.error(`unknown ledger subcommand: ${sub}`);
          return 1;
      }
    }

    case 'logs': {
      if (sub !== 'cleanup') {
        console.error('usage: logs cleanup [--dry-run]');
        return 1;
      }
      const dry = rest.includes('--dry-run');
      const envPulse = path.join(paths.logsDir, 'envpulse.jsonl');
      const cut1 = policy.retention.envPulseHours * 3600_000;
      const cut2 = policy.retention.decisionLogDays * 86_400_000;
      if (dry) {
        console.log(`(dry-run) would prune ${envPulse} to ${policy.retention.envPulseHours}h` +
          ` and ${decisionLog} to ${policy.retention.decisionLogDays}d`);
        return 0;
      }
      const a = pruneAuditFile(envPulse, cut1);
      const b = pruneAuditFile(decisionLog, cut2);
      appendAuditLine(decisionLog, { event: 'retention', pruned_envpulse: a, pruned_decision: b });
      console.log(`PRUNED envpulse:${a} decision:${b}`);
      return 0;
    }

    case 'browse': {
      switch (sub) {
        case 'status': {
          const st = browseStatus(guard, paths);
          const interests = loadInterests(paths);
          console.log(JSON.stringify({
            watchTargets: loadWatchlist(paths).targets?.length ?? 0,
            lastCheckAt: st.last_check_at ? new Date(st.last_check_at).toISOString() : null,
            lastWanderAt: st.wander.last_wander_at ? new Date(st.wander.last_wander_at).toISOString() : null,
            focusCount: st.wander.focusCount,
            interestCount: interests.interests?.length ?? 0,
          }, null, 2));
          return 0;
        }
        case 'dry': {
          const forced = new Date();
          forced.setHours(12, 0, 0, 0);
          const advice = adviseWander(guard, paths, policy, forced);
          console.log(JSON.stringify(advice, null, 2));
          return 0;
        }
        case 'watch': {
          const report = await checkWatchlist(guard, paths, { throttleOk: true });
          console.log(JSON.stringify({ checked: report.checked, updates: report.items.length, errors: report.errors }, null, 2));
          for (const item of report.items) console.log(`NEWS: ${item.text}`);
          return 0;
        }
        case 'done': {
          const focus = rest.join(' ').trim();
          if (!focus) {
            console.error('usage: browse done <focus>');
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

    case 'notify': {
      switch (sub) {
        case 'check':
          console.log(ensureRegistered(paths) ? 'REGISTERED: yes' : 'REGISTERED: no');
          return 0;
        case 'register':
          ensureRegistered(paths);
          console.log('register attempted');
          return 0;
        case 'send':
          console.log(sendNewMessageHint(paths) ? 'SENT' : 'FAILED');
          return 0;
        default:
          console.error('usage: notify check|register|send');
          return 1;
      }
    }

    case 'profile': {
      const doc = loadProfile(guard, profileFilePath(paths.dataDir));
      const all = rest.includes('--all');
      switch (sub) {
        case 'list': {
          let n = 0;
          for (const p of ['interest', 'projects', 'comm', 'psy'] as const) {
            for (const e of doc.partitions[p]!.entries) {
              if (!all && e.validTo !== null) continue;
              n += 1;
              console.log(`${e.id} [${e.partition}/${e.topic}/${e.subTopic}] ${e.temporal}` +
                ` conf=${e.confidence.toFixed(2)}${e.lowActivity ? ' 久未验证' : ''}${e.validTo ? ' [失效]' : ''}: ${e.content.slice(0, 60)}`);
            }
          }
          if (n === 0) console.log('(empty)');
          return 0;
        }
        case 'export': {
          const lines = [`# 画像导出 ${new Date().toISOString()}`, ''];
          for (const p of ['interest', 'projects', 'comm', 'psy'] as const) {
            lines.push(`## ${p}`);
            for (const e of doc.partitions[p]!.entries) {
              if (e.validTo !== null) continue;
              lines.push(`- [${e.topic}/${e.subTopic}] ${e.content} (conf ${e.confidence.toFixed(2)}, ${e.temporal})`);
            }
          }
          const out = path.join(paths.exportsDir, `profile-export-${Date.now()}.md`);
          writeText(guard, out, lines.join('\n') + '\n');
          console.log(`EXPORTED: ${out}`);
          return 0;
        }
        case 'verify': {
          const r = verifyProfile(guard, paths.dataDir);
          console.log(JSON.stringify(r, null, 2));
          return r.ok ? 0 : 1;
        }
        case 'rebuild': {
          const r = rebuildProfile(guard, paths.dataDir, { check: rest.includes('--check') });
          console.log(JSON.stringify(r, null, 2));
          return r.ok ? 0 : 1;
        }
        case 'wipe': {
          if (!rest.includes('--yes')) {
            console.log('REFUSED: add --yes to wipe profile data (profile.json/inbox/journal)');
            return 1;
          }
          for (const f of ['profile.json', 'profile_inbox.jsonl', 'profile_journal.jsonl']) {
            const abs = guard.assert(path.join(paths.dataDir, f));
            if (fs.existsSync(abs)) fs.rmSync(abs, { force: true });
          }
          console.log('WIPED (settings preserved; use burn for full shredding)');
          return 0;
        }
        default:
          console.error(`unknown profile subcommand: ${sub}`);
          return 1;
      }
    }

    case 'burn': {
      const yes = rest.includes('--yes');
      const all = rest.includes('--all');
      const plan = planBurn(guard, paths, all);
      console.log('预演（不会执行）:' );
      for (const p of plan) console.log(`  [${p.exists ? '存在' : '无  '}] ${p.target.file ?? p.target.dir}  ${p.target.note}`);
      if (!yes) {
        console.log('\n此操作让琥珀失忆。确认执行请加 --yes（' + (all ? '含 --all 连用户设定' : '用户设定保留') + '）');
        return 0;
      }
      const result = executeBurn(guard, paths, { all });
      console.log(`BURNED: ${result.burned.length} 项；MISSING: ${result.missing.length} 项`);
      return 0;
    }

    case 'sessions': {
      // Read-only enumeration of the host's persisted sessions (ids from the
      // on-disk store; titles live server-side and are not listed here).
      const root = path.join(os.homedir(), '.dsh', 'sessions');
      let found = 0;
      if (fs.existsSync(root)) {
        let own: string | null = null;
        try {
          own = (JSON.parse(loadEncryptedText(guard, path.join(paths.dataDir, 'gate.json')) ?? '{}') as { sessionId?: string }).sessionId ?? null;
        } catch { /* gate.json absent or unreadable */ }
        for (const slug of fs.readdirSync(root)) {
          for (const id of fs.readdirSync(path.join(root, slug))) {
            found += 1;
            const mark = id === own ? '  ← 心跳正身' : '';
            console.log(`${id}  [${slug}]${mark}`);
          }
        }
      }
      if (found === 0) console.log('(no persisted sessions found)');
      return 0;
    }

    case 'bind': {
      const { loadBindings, addBinding, removeBinding, bindingsFilePath } = await import('../core/bindings.js');
      switch (sub) {
        case 'list': {
          const data = loadBindings(guard, paths.settingsDir);
          let own: string | null = null;
          try {
            own = (JSON.parse(loadEncryptedText(guard, path.join(paths.dataDir, 'gate.json')) ?? '{}') as { sessionId?: string }).sessionId ?? null;
          } catch { /* absent */ }
          if (own) console.log(`心跳正身: ${own}（决策轮次发生地；bind remove 它 = 重置正身）`);
          for (const b of data.bindings) {
            console.log(`${b.sessionId}  deliver:${b.deliver ? '√' : '×'} observe:${b.observe ? '√' : '×'}`);
          }
          if (data.bindings.length === 0 && !own) console.log('(no bindings — expressions stay in the dedicated heartbeat session)');
          return 0;
        }
        case 'add': {
          const id = rest[0];
          if (!id || !id.startsWith('session-')) {
            console.error('usage: bind add <sessionId> [--observe] [--no-deliver]  (see: sessions list)');
            return 1;
          }
          const observe = rest.includes('--observe') || rest.includes('--observe-only');
          const deliver = !rest.includes('--no-deliver') && !rest.includes('--observe-only');
          const b = addBinding(guard, paths.settingsDir, id, { deliver, observe });
          console.log(`BOUND ${b.sessionId} deliver:${b.deliver} observe:${b.observe}`);
          return 0;
        }
        case 'remove': {
          const id = rest[0];
          if (!id) {
            console.error('usage: bind remove <sessionId>');
            return 1;
          }
          console.log(removeBinding(guard, paths.settingsDir, id) ? `UNBOUND ${id}` : 'NOT_FOUND');
          // Unbinding the HOME session resets it: the next beat creates a
          // fresh dedicated session (the old one goes quiet after restart).
          try {
            const state = JSON.parse(loadEncryptedText(guard, path.join(paths.dataDir, 'gate.json')) ?? '{}') as { sessionId?: string };
            if (state.sessionId === id) {
              fs.rmSync(guard.assert(path.join(paths.dataDir, 'gate.json')), { force: true });
              console.log('注意：这是心跳正身会话。已重置——下次心跳将创建新的正身会话（旧会话不再有心跳）');
              appendAuditLine(paths.logsDir + '/heartbeat.jsonl', { event: 'home_reset', oldSessionId: id });
            }
          } catch { /* gate.json absent: nothing to reset */ }
          return 0;
        }
        default:
          console.error('usage: bind list | add <sessionId> | remove <sessionId>');
          return 1;
      }
    }

    default:
      console.error(`unknown command: ${cmd}`);
      console.log(usage());
      return 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  // Direct execution guard; the CLI is also importable for tests.
  void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
