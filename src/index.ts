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
import { loadPolicy } from './config/load.js';
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
 */
export const inject = ['agents'];

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
  let timeInjectMinRef = config.timeInjectMin ?? 25;
  let statusbarEnabledRef = config.statusbar !== false;
  const applySettingsOverrides = (): void => {
    try {
      const v = sectionSource?.();
      if (!v) return;
      if (v.intervalMin && v.intervalMin >= 1) applyHeartbeatInterval(deps, v.intervalMin);
      if (v.maxDailySend && v.maxDailySend >= 1) getRuntime().policy.gate.maxDailySend = v.maxDailySend;
      if (typeof v.timeInjectMin === 'number' && v.timeInjectMin >= 0) timeInjectMinRef = v.timeInjectMin;
      if (typeof v.statusbar === 'boolean') statusbarEnabledRef = v.statusbar;
      ctx.logger.info('heartbeat: settings overrides live (interval %s, cap %s, timeInject %s)', v.intervalMin ?? '-', v.maxDailySend ?? '-', v.timeInjectMin ?? '-');
    } catch (e) {
      ctx.logger.warn('heartbeat: settings override failed (%s)', String(e).slice(0, 120));
    }
  };
  void (async () => {
    try {
      const { settingsNamespace, installSettingsSection } = await import('@deepseek-ai/dsh-settings');
      installSettingsSection(
        ctx as never,
        settingsNamespace('heartbeat'),
        Config as never,
        config as never,
        {
          setSource: (current) => { sectionSource = current as () => HeartbeatConfig; },
          onChange: () => { applySettingsOverrides(); },
        },
      );
      applySettingsOverrides();
      ctx.logger.info('heartbeat: settings section registered');
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
  // 端点分发见 src/rpc.ts（bindings/seeds/status/profile/ledger）。
  installHeartbeatRpc(ctx, { paths, guard, policy });

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
