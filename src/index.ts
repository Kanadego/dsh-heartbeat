// dsh-heartbeat plugin entry.
//
// Contract (verified against DSH 0.1.1-rc.2 + dsh-vision-router as the
// third-party reference): the package main exports a cordis plugin -
// { name, inject, Config, apply(ctx, config) }. The bundle-level
// cordis.patch.yml (dsh.bundle.patch) mounts it via
//   - insert: - id: heartbeat, name: dsh-heartbeat
// and the loader resolves `name` to this package's main export.

import z from '@deepseek-ai/schemastery';
import { initWorkspace } from './core/paths.js';
import { createPathGuard } from './core/path-guard.js';
import { appendAuditLine } from './core/audit-log.js';
import { loadPolicy, updateUserPolicy } from './config/load.js';
import { loadUiConfig, saveUiConfig, type UiConfig } from './config/ui-config.js';
import { deepMerge } from './config/schema.js';
import { setRuntime, getRuntime } from './core/runtime.js';
import { startOrchestrator, applyHeartbeatInterval, type OrchestratorDeps } from './core/orchestrator.js';
import { installHeartbeatRpc } from './rpc.js';
import { registerTimeInjection } from './statusbar/time-inject.js';
import { registerStatusbarSection, noteTrack, pinTrack } from './statusbar/track.js';
import { StatusReader } from './statusbar/store.js';
import { renderStatusText } from './statusbar/track.js';
import { installBundledPreset, userPresetRoot, describeInstall } from './core/preset-install.js';
import { registerHeartbeatPreset } from './core/preset-definition.js';
import { buildLedgerTool } from './ledger/tool.js';
import { buildSeedReportTool, reportFilePath } from './seeds/report.js';
import { ledgerFilePath } from './ledger/ledger.js';

export const name = 'heartbeat';

/**
 * Host services required by the orchestrator (verified present in
 * DSH 0.1.1-rc.2 via hb-probe: agents service + agent/created + followup).
 * `settings` = the host SettingsProvider service (0.1.5): the web card's
 * rhythm edits live there. 0.1.5's strict resolution refuses undeclared
 * service access, so the name must be declared here.
 */
export const inject = ['agents', 'settings'];

export const Config = z.object({
  /** Override the runtime data dir (workspace guard boundary). Empty = default (<packageRoot>/data). */
  dataDir: z.string().default(''),
  /** UI-editable: heartbeat interval in minutes. 0 = use policy file / factory. */
  intervalMin: z.number().default(0),
  /** UI-editable: daily expression cap. 0 = use policy file / factory. */
  maxDailySend: z.number().default(0),
  /**
   * Agent preset the heartbeat agent joins (`<dshHome>/.agent-presets/<id>/`).
   * Without a preset the agent is a BARE agent: tools/prompt sections resolve
   * against the empty global layer, so it cannot even see `web_search`.
   */
  agentPreset: z.string().default('heartbeat'),
  /**
   * Install the bundled preset (see `agentPreset`) into the roster's user root
   * on first run, so setup needs no manual file copy. An existing preset is
   * never overwritten; set false to manage the preset entirely by hand.
   */
  installPreset: z.boolean().default(true),
  /** Self-built time injection interval (D20, §17.6). 0 disables injection. */
  timeInjectMin: z.number().default(25),
  /** IANA timezone for the injected clock; empty = process zone. */
  timeZone: z.string().default(''),
  /** Statusbar master switch (D19). Off = no section/pre-step status; time injection unaffected. */
  statusbar: z.boolean().default(true),
  /** v1.6.3 闲着模式：素材池为空时用画像话题兜底主动搭话（默认关）。 */
  idleMode: z.boolean().default(false),
  /** v1.7.0 节省 token 模式：用户离开（闲置 ≥30 分钟）或锁屏时整跳暂停（默认关）。 */
  tokenSaver: z.boolean().default(false),
  /** v1.8.0 账本工具：向所有日常会话 agent 注册共享账本工具（默认开）。 */
  ledgerTool: z.boolean().default(true),
  /** v1.9.0 素材报账工具：投递后由陪伴 agent 主动报账（默认开）。 */
  seedReportTool: z.boolean().default(true),
  /** v1.8.0 引擎室追加工具：逗号分隔的全局工具名，存在才加入白名单（bili 压缩工具自动探测，无需手填）。 */
  extraTools: z.string().default(''),
});

export interface HeartbeatConfig {
  dataDir?: string | null;
  intervalMin?: number;
  maxDailySend?: number;
  agentPreset?: string;
  installPreset?: boolean;
  timeInjectMin?: number;
  timeZone?: string;
  statusbar?: boolean;
  idleMode?: boolean;
  tokenSaver?: boolean;
  ledgerTool?: boolean;
  seedReportTool?: boolean;
  extraTools?: string;
}

export function apply(ctx: OrchestratorDeps['ctx'] & {
  get(name: string): unknown;
  /** Cordis lazy service declaration: callback runs once the named services mount. */
  inject(services: string[], callback: (scoped: unknown) => void): void;
  /** Cordis event subscription (pre-step waterfall etc.); returns a disposer. */
  on(event: string, listener: (payload: never, next: () => Promise<unknown>) => Promise<unknown>, opts?: { prepend?: boolean }): unknown;
}, config: HeartbeatConfig = {}): void {
  const paths = initWorkspace(config.dataDir ? { dataDir: config.dataDir } : {});
  const guard = createPathGuard(paths.dataDir);
  let policy = loadPolicy(guard, paths.configDir, paths.settingsDir);

  // Card-edited rhythm values (v1.7.0, data/settings/ui.json): the settings
  // card writes these over RPC. Precedence: policy layers < ui.json < the
  // composition-entry config below.
  const ui = loadUiConfig(guard, paths.settingsDir);
  if (ui.intervalMin && ui.intervalMin >= 1) {
    policy = { ...policy, heartbeat: { ...policy.heartbeat, intervalMin: ui.intervalMin } };
  }
  if (ui.maxDailySend && ui.maxDailySend >= 1) {
    policy = { ...policy, gate: { ...policy.gate, maxDailySend: ui.maxDailySend } };
  }

  // Composition-entry overrides (the patch row's config block).
  if (config.intervalMin && config.intervalMin >= 1) {
    policy = { ...policy, heartbeat: { ...policy.heartbeat, intervalMin: config.intervalMin } };
  }
  if (config.maxDailySend && config.maxDailySend >= 1) {
    policy = { ...policy, gate: { ...policy.gate, maxDailySend: config.maxDailySend } };
  }

  const deps: OrchestratorDeps = {
    ctx, paths, guard, policy,
    agentPreset: config.agentPreset || 'heartbeat',
    extraTools: (config.extraTools ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    presetRegistration: () => presetRegistration ?? Promise.resolve(),
  };
  setRuntime({
    paths,
    guard,
    policy,
    flags: {
      statusbarEnabled: () => statusbarEnabledRef,
      timeInjectMin: () => timeInjectMinRef,
      idleMode: () => idleModeRef,
      tokenSaver: () => tokenSaverRef,
    },
  });

  // Runtime preset registration (issue #2). The `agentPresets` inject below
  // assigns it; the acquire path awaits it before mounting the preset.
  let presetRegistration: Promise<void> | undefined;

  // ── Preset: runtime registration + filesystem install (C13 / issue #2) ───
  // The preset is what lets the heartbeat agent see `web_search` at all, so
  // the plugin owns it in both senses:
  //
  //  1. RUNTIME REGISTRATION (0.1.7+). The registry takes a definition
  //     straight from the declaring plugin (`AgentPresetRegistry.register`),
  //     so nothing in the composition has to name
  //     `@deepseek-ai/dsh-agent-preset`. That matters: a profile cannot always
  //     resolve it, and its peer closure contains Cordis's own loader — a
  //     profile that ships those by hand double-instances the machinery, and
  //     then every session refuses to resume ("prompt section
  //     deployment:persona-prefix is already registered"), while one that
  //     cannot resolve the package fails the WHOLE plugin tree at load
  //     (reported 2026-10-10, both with reproductions). A host whose registry
  //     has no `register` degrades to an audit line, never a throw.
  //  2. FILESYSTEM INSTALL, kept for hosts that still scan the roster's user
  //     root (`agentPresets.roots`, trust === "user"): first run writes the
  //     bundled template under the roster's OWN root instead of a guessed
  //     `~/.dsh`, so `$DSH_HOME`/a configured home are honoured; an existing
  //     preset is never overwritten.
  //
  // `installPreset: false` means "the operator manages the preset by hand", so
  // it switches BOTH off. Audit lines: `preset_register`, `preset_install`.
  ctx.inject(['agentPresets'], (presetCtx: unknown) => {
    const service = (presetCtx as {
      agentPresets?: { roots?: Array<{ path?: string; trust?: string }> };
    }).agentPresets;
    const presetId = config.agentPreset || 'heartbeat';
    const installEnabled = config.installPreset !== false;
    const audit = (entry: Record<string, unknown>): void => {
      try {
        appendAuditLine(guard.assert(paths.logsDir + '/heartbeat.jsonl'), entry);
      } catch (e) {
        ctx.logger.warn('heartbeat: preset audit failed (%s)', String(e).slice(0, 120));
      }
    };

    presetRegistration = registerHeartbeatPreset(service, presetId, installEnabled).then((result) => {
      audit({ event: 'preset_register', ...result });
      if (result.action === 'error') {
        ctx.logger.warn('heartbeat: preset register failed (%s) — the engine room runs without it', result.detail ?? '');
      } else if (result.action === 'registered') {
        ctx.logger.info('heartbeat: preset %s registered at runtime', result.id);
      } else {
        ctx.logger.info('heartbeat: preset registration skipped (%s)', result.action);
      }
    });

    const root = userPresetRoot(service?.roots);
    const result = installBundledPreset({
      moduleUrl: import.meta.url,
      id: presetId,
      ...(root === undefined ? { rosterKnown: service !== undefined } : { root }),
      enabled: installEnabled,
    });
    audit({ event: 'preset_install', ...result });
    const line = describeInstall(result);
    if (result.action === 'error' || result.action === 'skipped-no-root') {
      ctx.logger.warn('heartbeat: %s', line);
    } else {
      ctx.logger.info('heartbeat: %s', line);
    }
  });

  // M6: settings section (namespace 'heartbeat') - the web card edits this
  // namespace; resolved values apply live (interval reschedules the timer).
  let sectionSource: (() => HeartbeatConfig) | null = null;
  let timeInjectMinRef = ui.timeInjectMin ?? (config.timeInjectMin ?? 25);
  let statusbarEnabledRef = ui.statusbar ?? (config.statusbar !== false);
  let idleModeRef = ui.idleMode ?? (config.idleMode === true);
  let tokenSaverRef = ui.tokenSaver ?? (config.tokenSaver === true);

  // H-48: ONE setter table for the live-settable fields. The settings section
  // and the RPC uiSet path used to carry a copy each of the same six ifs, so a
  // new field had to be added twice — and the two copies had already drifted
  // (timeInjectMin's lower bound, tokenSaver's absence from the section path).
  const applyLiveSettings = (v: {
    intervalMin?: number;
    maxDailySend?: number;
    timeInjectMin?: number;
    statusbar?: boolean;
    idleMode?: boolean;
    tokenSaver?: boolean;
  }): void => {
    if (v.intervalMin && v.intervalMin >= 1) applyHeartbeatInterval(deps, v.intervalMin);
    if (v.maxDailySend && v.maxDailySend >= 1) getRuntime().policy.gate.maxDailySend = v.maxDailySend;
    if (typeof v.timeInjectMin === 'number' && v.timeInjectMin >= 0) timeInjectMinRef = v.timeInjectMin;
    if (typeof v.statusbar === 'boolean') statusbarEnabledRef = v.statusbar;
    if (typeof v.idleMode === 'boolean') {
      idleModeRef = v.idleMode;
      getRuntime().policy.heartbeat.idleMode = v.idleMode;
    }
    if (typeof v.tokenSaver === 'boolean') tokenSaverRef = v.tokenSaver;
  };

  const applySettingsOverrides = (): void => {
    try {
      const v = sectionSource?.();
      if (!v) return;
      applyLiveSettings(v);
      ctx.logger.info('heartbeat: settings overrides live (interval %s, cap %s, timeInject %s)', v.intervalMin ?? '-', v.maxDailySend ?? '-', v.timeInjectMin ?? '-');
    } catch (e) {
      ctx.logger.warn('heartbeat: settings override failed (%s)', String(e).slice(0, 120));
    }
  };
  void (async () => {
    try {
      // Three settings generations, feature-detected in order:
      //  - 0.1.5 (dsh-settings 0.1.5-rc.2): the free function moved onto the
      //    host `settings` service as the `installSection` METHOD.
      //  - 0.1.7+: the service is `SettingsForms` — plugin config forms render
      //    from the Config schema on the Plugins page, and an edit RELOADS
      //    this plugin (timers dispose via ctx.effect, so reloads are safe).
      //    Nothing to register; the apply-time `config` is the live source.
      //  - 0.1.1/0.1.2 era hosts: the free function still exists on the
      //    package. Only consulted when NO settings service is present —
      //    running it against a 0.1.7 host would poke foreign internals.
      const settingsService = (ctx as unknown as { get(name: string): unknown }).get('settings') as
        | {
            installSection(
              owner: unknown,
              ns: string,
              schema: unknown,
              entry: unknown,
              hooks: { setSource(fn: () => unknown): void; onChange(): void },
            ): void;
            describe?(options?: unknown): unknown;
          }
        | undefined;
      if (settingsService && typeof settingsService.installSection === 'function') {
        settingsService.installSection(ctx, 'heartbeat', Config, config, {
          setSource: (current) => { sectionSource = current as () => HeartbeatConfig; },
          onChange: () => { applySettingsOverrides(); },
        });
        applySettingsOverrides();
        ctx.logger.info('heartbeat: settings section registered (0.1.5 settings service)');
        return;
      }
      if (settingsService && typeof settingsService.describe === 'function') {
        sectionSource = () => config;
        applySettingsOverrides();
        ctx.logger.info('heartbeat: config served by the 0.1.7 profile form (edits reload the plugin)');
        return;
      }
      const legacy = (await import('@deepseek-ai/dsh-settings')) as {
        settingsNamespace?(ns: string): string;
        installSettingsSection?(ctx: unknown, ns: string, schema: unknown, entry: unknown, hooks: object): void;
      };
      if (typeof legacy.installSettingsSection === 'function' && typeof legacy.settingsNamespace === 'function') {
        legacy.installSettingsSection(ctx as never, legacy.settingsNamespace('heartbeat'), Config as never, config as never, {
          setSource: (current: unknown) => { sectionSource = current as () => HeartbeatConfig; },
          onChange: () => { applySettingsOverrides(); },
        });
        applySettingsOverrides();
        ctx.logger.info('heartbeat: settings section registered (legacy 0.1.1 settings)');
        return;
      }
      ctx.logger.warn('heartbeat: no settings integration found; policy file values only');
    } catch (e) {
      ctx.logger.warn('heartbeat: settings section unavailable (%s)', String(e).slice(0, 120));
    }
  })();

  appendAuditLine(
    guard.assert(paths.logsDir + '/heartbeat.jsonl'),
    { event: 'plugin_init', dataDir: paths.dataDir },
  );

  // issue #2: a package-local data dir is moved out of the package on first
  // sight. The audit line is the only durable trace; a failed move keeps
  // serving the legacy tree (and never deletes it).
  if (paths.relocation) {
    const auditFile = guard.assert(paths.logsDir + '/heartbeat.jsonl');
    if (paths.relocation.action === 'relocated') {
      appendAuditLine(auditFile, {
        event: 'data_dir_relocated',
        from: paths.relocation.srcDir,
        to: paths.relocation.dstDir,
        files: paths.relocation.files,
        bytes: paths.relocation.bytes,
        warnings: paths.relocation.warnings,
        leftovers: paths.relocation.leftovers,
      });
      ctx.logger.info(
        'heartbeat: data dir moved out of the package (%s files, %s bytes)',
        paths.relocation.files,
        paths.relocation.bytes,
      );
    } else if (paths.relocation.action === 'failed') {
      appendAuditLine(auditFile, {
        event: 'data_dir_relocate_failed',
        stage: paths.relocation.stage,
        problems: paths.relocation.problems,
      });
      ctx.logger.warn(
        'heartbeat: data dir relocation failed (%s); continuing in the package dir',
        paths.relocation.stage,
      );
    }
  }

  // ── M6 拓展：正式 RPC 通道（决策 1 = B 方案，探针已验证）──────────
  // connection 晚挂载 → ctx.inject(['connection'], ...) 声明式等待；
  // 端点分发见 src/rpc.ts（bindings/seeds/status/profile/ledger/config）。
  // ui.get/uiSet：节律配置的活视图与"落盘+即时生效"（v1.7.0，data/settings/ui.json）。
  // psyEnabled 例外：它是 policy 字段，写 data/settings/policy.json 用户层。
  const uiGet = () => ({
    intervalMin: getRuntime().policy.heartbeat.intervalMin,
    maxDailySend: getRuntime().policy.gate.maxDailySend,
    timeInjectMin: timeInjectMinRef,
    statusbar: statusbarEnabledRef,
    idleMode: idleModeRef,
    tokenSaver: tokenSaverRef,
    psyEnabled: getRuntime().policy.profile.psyEnabled,
  });
  const uiSet = (patch: UiConfig & { psyEnabled?: boolean }): void => {
    if (typeof patch.psyEnabled === 'boolean') {
      updateUserPolicy(guard, paths.settingsDir, { profile: { psyEnabled: patch.psyEnabled } });
      getRuntime().policy.profile.psyEnabled = patch.psyEnabled;
    }
    const merged = saveUiConfig(guard, paths.settingsDir, patch);
    applyLiveSettings(merged);
  };
  installHeartbeatRpc(ctx, { paths, guard, policy, ui: { get: uiGet, set: uiSet } });

  // H-49: the ledger (v1.8.0) and seed_report (v1.9.0) registrations were two
  // copies of one block — same audit closure, same try/catch, same degradation
  // to an audit line on a host without a registerable ToolRuntime. One factory
  // now covers both; the audit event names are unchanged.
  const registerGlobalTool = (name: string, build: () => unknown): void => {
    ctx.inject(['tools'], (scoped: unknown) => {
      const audit = (entry: Record<string, unknown>): void => {
        try {
          appendAuditLine(guard.assert(paths.logsDir + '/heartbeat.jsonl'), entry);
        } catch { /* audit must never break startup */ }
      };
      try {
        const tools = (scoped as { tools?: { register(definition: unknown): () => void } }).tools;
        if (!tools || typeof tools.register !== 'function') throw new Error('ToolRuntime.register unavailable on this host');
        tools.register(build());
        audit({ event: `${name}_tool_registered` });
      } catch (e) {
        audit({ event: `${name}_tool_register_failed`, error: String(e).slice(0, 160) });
      }
    });
  };

  // ── Ledger as a model tool (v1.8.0) ─────────────────────────────────────
  // Registers a shared `ledger` tool in the GLOBAL tool layer so every chat
  // agent can record/complete todos without being commanded to. The engine
  // room never sees it (its preset allow-list masks global tools). Definition
  // is a plain object (no dsh-tools import); a host without a registerable
  // ToolRuntime degrades to an audit line only.
  if (config.ledgerTool !== false) {
    registerGlobalTool('ledger', () => buildLedgerTool(guard, ledgerFilePath(paths.dataDir)));
  }

  // ── Seed report tool (v1.9.0): the persona files ONE report per delivery ─
  // spoken / seed_ids / profile_ids / reason — the unified bookkeeping channel
  // that replaced containment-match attribution. Same global-layer pattern as
  // the ledger tool; the engine room never sees it.
  if (config.seedReportTool !== false) {
    registerGlobalTool('seed_report', () => buildSeedReportTool(guard, reportFilePath(paths.dataDir)));
  }

  // §7 main loop: dedicated session/agent + timer (first beat after 15s).
  startOrchestrator(deps);

  // ── M7b: self-built time injection (D20, §17.6) ────────────────────────
  // Gate: step===1 AND user-initiated AND ≥ timeInjectMin since the last
  // injection for that session. Official dsh-time-context is disabled via the
  // user patch (B9 superseded by D20 — single owner). The interval is
  // live-settable: `timeInjectMinRef` is re-read on every gate check.
  // ── M7c: statusbar two tracks (D19, §17.4–17.5) ─────────────────────────
  // Track A (in-history models) rides a dynamic system-prompt section; Track B
  // rides the same pre-step message as the time injection (§17.5 combined).
  const statusReader = new StatusReader();
  registerStatusbarSection(ctx, guard, paths, {
    enabled: () => statusbarEnabledRef,
    reader: statusReader,
  });
  ctx.effect(() => {
    registerTimeInjection(ctx, guard, paths.dataDir, {
      getTimeInjectMin: () => timeInjectMinRef,
      timeZone: config.timeZone || undefined,
      paths,
      logger: ctx.logger,
      onError: (e) => ctx.logger.warn('heartbeat: time injection skipped (%s)', String(e).slice(0, 120)),
      pinTrack: (sessionId, session) => {
        const track = pinTrack(sessionId, session);
        noteTrack(paths.logsDir + '/heartbeat.jsonl', sessionId, track);
        return track;
      },
      getStatusLine: (session, track) => {
        if (!statusbarEnabledRef) {
          noteTrack(paths.logsDir + '/heartbeat.jsonl', session.id, 'off');
          return '';
        }
        return track === 'pre-step' ? renderStatusText(statusReader.read(guard, paths)) : '';
      },
    });
    return undefined;
  }, 'heartbeat: time injection');

  // Host effect contract: fn runs immediately, returns the disposer.
  ctx.effect(() => {
    return () => {
      ctx.logger.info('heartbeat: disposed, timers cleaned up');
    };
  }, 'heartbeat: lifecycle');
}

// deepMerge is re-exported for the CLI status command layering.
export { deepMerge };
