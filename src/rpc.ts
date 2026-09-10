// M6: custom RPC channel '/heartbeat' (decision 1 = Plan B).
//
// Host registers via ctx.inject(['connection'], ...) once the connection
// service mounts; the web card calls connection.rpc.call(channel, endpoint,
// payload). Bindings authority = data/settings/bindings.json (decision 2);
// the card is just another client of the same host logic the CLI uses.
// Every endpoint runs inside the workspace guard; results are {ok,value} or
// {ok:false,error:{code,message}}.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OrchestratorDeps } from './core/orchestrator.js';
import { getLastBeat } from './core/orchestrator.js';
import type { PathGuard } from './core/path-guard.js';
import type { WorkspacePaths } from './core/paths.js';
import { inQuietHours, readSentState } from './gate/gate.js';
import {
  activeSeeds,
  archivedSeeds,
  archiveSeedById,
  deleteSeed,
  loadPool,
  restoreSeed,
  seedsFilePath,
} from './seeds/pool.js';
import { loadProfile, profileFilePath } from './profile/store.js';
import { buildDigest } from './profile/digest.js';
import { ledgerFilePath } from './ledger/ledger.js';
import { addBinding, loadBindings, removeBinding } from './core/bindings.js';
import { loadEncryptedText, writeText } from './vault/vault.js';
import type { Policy } from './config/schema.js';

export const RPC_CHANNEL = '/heartbeat';

interface RpcDeps {
  ctx: OrchestratorDeps['ctx'] & {
    inject(services: string[], callback: (scoped: unknown) => void): void;
  };
  paths: WorkspacePaths;
  guard: PathGuard;
  policy: Policy;
}

type RpcResult = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };

const ok = (value: unknown): RpcResult => ({ ok: true, value });
const err = (code: string, message: string): RpcResult => ({ ok: false, error: { code, message } });

function homeSessionId(paths: WorkspacePaths, guard: PathGuard): string | null {
  try {
    const raw = loadEncryptedText(guard, path.join(paths.dataDir, 'gate.json'));
    return (JSON.parse(raw ?? '{}') as { sessionId?: string }).sessionId ?? null;
  } catch {
    return null;
  }
}

/** Session titles from the host's projection cache. Titles are host data — the
 * client card merges them (client.js `nameOf`: title || id prefix).
 *
 * DSH 0.1.2 writes ONE RECORD PER SESSION under
 * `~/.dsh/storages/session_projcache/sessions/<sessionId>.json`
 * (`record.rows.title.val`). The single-file `session_projcache.json` we used
 * before is the older aggregate layout and goes stale: a session created after
 * the upgrade is simply absent from it, so `title` came back null and the card
 * printed the raw session id. Read the per-record layout FIRST, keep the
 * aggregate only as a legacy fallback. */
function loadSessionTitles(): Record<string, string> {
  const titles: Record<string, string> = {};
  const take = (id: string, value: unknown): void => {
    const t = value as { rows?: { title?: { val?: unknown } }; title?: { val?: unknown } } | undefined;
    const row = t?.rows?.title ?? t?.title;
    if (row && typeof row.val === 'string' && row.val && !titles[id]) titles[id] = row.val;
  };
  // 1) per-record layout (current).
  try {
    const dir = path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions');
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -'.json'.length);
      if (!id.startsWith('session-')) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as { record?: unknown };
        take(id, record.record);
      } catch { /* skip a record we cannot read */ }
    }
  } catch { /* no per-record dir on older hosts */ }
  // 2) legacy aggregate fallback.
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'storages', 'session_projcache.json'), 'utf8')) as unknown;
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key.startsWith('session-') && value && typeof value === 'object') {
          // Title lives at <session>.rows.title.val (host title service); the
          // val may be null while the title is still being generated.
          take(key, value);
        }
        walk(value);
      }
    };
    walk(raw);
    return titles;
  } catch {
    return titles;
  }
}

export function installHeartbeatRpc(
  ctx: OrchestratorDeps['ctx'] & { inject(services: string[], callback: (scoped: unknown) => void): void },
  deps: Omit<RpcDeps, 'ctx'>,
): void {
  ctx.inject(['connection'], (scoped: unknown) => {
    const remoteCtx = scoped as {
      connection: { rpc: { handle(channel: string, handler: unknown, opts?: unknown): unknown } };
      agents: OrchestratorDeps['ctx']['agents'];
    };

    const isLive = (sessionId: string): boolean => {
      try {
        return !!remoteCtx.agents.get(sessionId);
      } catch {
        return false;
      }
    };

    const handler = async (endpoint: unknown, payload: unknown): Promise<RpcResult> => {
      const { guard, paths, policy } = deps;
      const p = (payload ?? {}) as Record<string, unknown>;
      try {
        switch (endpoint) {
          case 'status': {
            const now = Date.now();
            const sent = readSentState(guard, paths, now);
            const beat = getLastBeat();
            return ok({
              now: new Date(now).toISOString(),
              intervalMin: policy.heartbeat.intervalMin,
              cap: { used: sent.items.length, max: policy.gate.maxDailySend },
              quiet: inQuietHours(policy, now),
              lastBeat: beat,
              homeSessionId: homeSessionId(paths, guard),
              bindings: loadBindings(guard, paths.settingsDir).bindings.length,
            });
          }

          case 'sessions.list': {
            const root = path.join(os.homedir(), '.dsh', 'sessions');
            const bindings = loadBindings(guard, paths.settingsDir).bindings;
            const home = homeSessionId(paths, guard);
            const titles = loadSessionTitles();
            const out: Record<string, unknown>[] = [];
            if (fs.existsSync(root)) {
              for (const slug of fs.readdirSync(root)) {
                for (const id of fs.readdirSync(path.join(root, slug))) {
                  const binding = bindings.find((b) => b.sessionId === id);
                  out.push({
                    id,
                    title: titles[id] ?? null,
                    cwdSlug: slug,
                    live: isLive(id),
                    home: id === home,
                    deliver: binding?.deliver ?? false,
                    observe: binding?.observe ?? false,
                  });
                }
              }
            }
            return ok({ sessions: out });
          }

          case 'bindings.get':
            return ok(loadBindings(guard, paths.settingsDir));

          case 'bindings.add': {
            const id = String(p.sessionId ?? '');
            if (!id.startsWith('session-')) return err('bad-request', 'sessionId must look like session-...');
            const home = homeSessionId(paths, guard);
            if (id === home) return err('bad-request', '该会话是心跳正身，无需绑定（决策轮次固定发生在正身）');
            // Callers send BOTH flags explicitly (the card's per-flag toggles), so
            // this stays a full-state write: deliver defaults on, observe off.
            const b = addBinding(guard, paths.settingsDir, id, {
              deliver: p.deliver !== false,
              observe: p.observe === true,
            });
            return ok(b);
          }

          case 'bindings.remove': {
            const id = String(p.sessionId ?? '');
            const removed = removeBinding(guard, paths.settingsDir, id);
            let homeReset = false;
            if (id === homeSessionId(paths, guard)) {
              try {
                fs.rmSync(guard.assert(path.join(paths.dataDir, 'gate.json')), { force: true });
                homeReset = true;
              } catch { /* absent */ }
            }
            return ok({ removed, homeReset });
          }

          case 'seeds.list': {
            const db = loadPool(guard, seedsFilePath(paths.dataDir));
            return ok({
              active: activeSeeds(db),
              archived: archivedSeeds(db),
              cap: policy.seeds.maxActive,
            });
          }

          case 'seeds.archive': {
            const s = archiveSeedById(guard, seedsFilePath(paths.dataDir), String(p.id ?? ''), 'completed');
            return s ? ok(s) : err('not-found', 'active seed not found');
          }

          case 'seeds.restore': {
            const r = restoreSeed(guard, seedsFilePath(paths.dataDir), policy, String(p.id ?? ''));
            return r.ok ? ok(r.seed) : err('restore-failed', r.reason);
          }

          case 'seeds.delete': {
            return ok({ deleted: deleteSeed(guard, seedsFilePath(paths.dataDir), String(p.id ?? '')) });
          }

          case 'profile.digest': {
            const d = buildDigest(guard, paths, policy, {});
            return ok({
              tact: d.tact,
              topic: d.topic,
              wander: d.wander,
              withinBudget: d.withinBudget,
            });
          }

          case 'profile.export': {
            const doc = loadProfile(guard, profileFilePath(paths.dataDir));
            const lines = [`# 画像导出 ${new Date().toISOString()}`, ''];
            for (const part of ['interest', 'projects', 'comm', 'psy'] as const) {
              lines.push(`## ${part}`);
              for (const e of doc.partitions[part]!.entries) {
                if (e.validTo !== null) continue;
                lines.push(`- [${e.topic}/${e.subTopic}] ${e.content} (conf ${e.confidence.toFixed(2)}, ${e.temporal})`);
              }
            }
            const out = path.join(paths.exportsDir, `profile-export-${Date.now()}.md`);
            writeText(guard, out, lines.join('\n') + '\n');
            return ok({ path: out });
          }

          case 'ledger.open': {
            const f = ledgerFilePath(paths.dataDir);
            if (!fs.existsSync(guard.assert(f))) fs.writeFileSync(f, '# 账本\n', 'utf8');
            spawn('cmd', ['/c', 'start', '', f], { detached: true, stdio: 'ignore' }).unref();
            return ok({ path: f });
          }

          default:
            return err('bad-request', `unknown endpoint ${JSON.stringify(endpoint)}`);
        }
      } catch (e) {
        return err('internal', String(e).slice(0, 200));
      }
    };

    remoteCtx.connection.rpc.handle(RPC_CHANNEL, handler, { authority: 'trusted-host' });
    ctx.logger.info('heartbeat: rpc channel ready (%s)', RPC_CHANNEL);
  });
}
