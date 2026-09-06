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
});

export interface HeartbeatConfig {
  dataDir?: string | null;
  intervalMin?: number;
  maxDailySend?: number;
}

export function apply(ctx: OrchestratorDeps['ctx'] & { get(name: string): unknown }, config: HeartbeatConfig = {}): void {
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

  const deps: OrchestratorDeps = { ctx, paths, guard, policy };
  setRuntime({ paths, guard, policy });

  // M6: settings section (namespace 'heartbeat') - the web card edits this
  // namespace; resolved values apply live (interval reschedules the timer).
  let sectionSource: (() => HeartbeatConfig) | null = null;
  const applySettingsOverrides = (): void => {
    try {
      const v = sectionSource?.();
      if (!v) return;
      if (v.intervalMin && v.intervalMin >= 1) applyHeartbeatInterval(deps, v.intervalMin);
      if (v.maxDailySend && v.maxDailySend >= 1) getRuntime().policy.gate.maxDailySend = v.maxDailySend;
      ctx.logger.info('heartbeat: settings overrides live (interval %s, cap %s)', v.intervalMin ?? '-', v.maxDailySend ?? '-');
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

  // §7 main loop: dedicated session/agent + timer (first beat after 15s).
  startOrchestrator(deps);

  // Host effect contract: fn runs immediately, returns the disposer.
  ctx.effect(() => {
    return () => {
      ctx.logger.info('heartbeat: disposed, timers cleaned up');
    };
  }, 'heartbeat: lifecycle');
}

// deepMerge is re-exported for the CLI status command layering.
export { deepMerge };
