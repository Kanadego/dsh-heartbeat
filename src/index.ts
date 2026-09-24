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

  const deps: OrchestratorDeps = { ctx, paths, guard, policy, agentPreset: config.agentPreset || 'heartbeat' };
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

  // ── Bundled preset self-install (C13) ───────────────────────────────────
  // The preset is what lets the heartbeat agent see `web_search` at all, and
  // hand-copying two YAML files was the most error-prone step of setup, so the
  // plugin installs its own template on first run. The target comes from the
  // roster's own roots (`agentPresets.roots`, trust === "user") instead of a
  // guessed `~/.dsh`, so `$DSH_HOME`/a configured home are honoured; an existing
  // preset is never overwritten. Audit line: `preset_install`.
  ctx.inject(['agentPresets'], (presetCtx: unknown) => {
    const service = (presetCtx as {
      agentPresets?: { roots?: Array<{ path?: string; trust?: string }> };
    }).agentPresets;
    const root = userPresetRoot(service?.roots);
    const result = installBundledPreset({
      moduleUrl: import.meta.url,
      id: config.agentPreset || 'heartbeat',
      ...(root === undefined ? { rosterKnown: service !== undefined } : { root }),
      enabled: config.installPreset !== false,
    });
    try {
      appendAuditLine(guard.assert(paths.logsDir + '/heartbeat.jsonl'), {
        event: 'preset_install',
        ...result,
      });
    } catch (e) {
      ctx.logger.warn('heartbeat: preset_install audit failed (%s)', String(e).slice(0, 120));
    }
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
  const applySettingsOverrides = (): void => {
    try {
      const v = sectionSource?.();
      if (!v) return;
      if (v.intervalMin && v.intervalMin >= 1) applyHeartbeatInterval(deps, v.intervalMin);
      if (v.maxDailySend && v.maxDailySend >= 1) getRuntime().policy.gate.maxDailySend = v.maxDailySend;
      if (typeof v.timeInjectMin === 'number' && v.timeInjectMin >= 0) timeInjectMinRef = v.timeInjectMin;
      if (typeof v.statusbar === 'boolean') statusbarEnabledRef = v.statusbar;
      if (typeof v.idleMode === 'boolean') {
        idleModeRef = v.idleMode;
        getRuntime().policy.heartbeat.idleMode = v.idleMode;
      }
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
    if (merged.intervalMin && merged.intervalMin >= 1) applyHeartbeatInterval(deps, merged.intervalMin);
    if (merged.maxDailySend && merged.maxDailySend >= 1) getRuntime().policy.gate.maxDailySend = merged.maxDailySend;
    if (typeof merged.timeInjectMin === 'number') timeInjectMinRef = merged.timeInjectMin;
    if (typeof merged.statusbar === 'boolean') statusbarEnabledRef = merged.statusbar;
    if (typeof merged.idleMode === 'boolean') {
      idleModeRef = merged.idleMode;
      getRuntime().policy.heartbeat.idleMode = merged.idleMode;
    }
    if (typeof merged.tokenSaver === 'boolean') tokenSaverRef = merged.tokenSaver;
  };
  installHeartbeatRpc(ctx, { paths, guard, policy, ui: { get: uiGet, set: uiSet } });

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
