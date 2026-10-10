// The heartbeat agent preset, as a runtime registration (issue #2, 2026-10-10).
//
// 0.1.7+ mounts presets from the profile COMPOSITION: a row named
// `@deepseek-ai/dsh-agent-preset` whose `config` is the definition. That row
// makes the PROFILE resolve the package — and `@deepseek-ai/dsh-agent-preset`
// is thin (it only forwards its config to `agentPresets.register`), but its
// peer closure contains `cordis-plugin-loader` / `cordis-plugin-include` /
// `cordis-plugin-group`, i.e. the loading machinery itself. So a profile that
// cannot resolve it fails the WHOLE plugin tree ("plugin tree failed to load"
// on 0.1.5), and one that satisfies it by hand double-instances the machinery
// ("prompt section deployment:persona-prefix is already registered", every
// session then refuses to resume). Both were reported with reproductions.
//
// The registry exposes `register(definition)` for exactly this case — its
// docstring: "Parsed configuration supplied by the declaring plugin" — so the
// plugin now registers its own preset at runtime and the bundle patch carries
// no host-package reference at all. The definition below is the same content
// the composition used to hold (and the same as
// `assets/presets/heartbeat/agent.cordis.yml`, which older hosts still read
// off the filesystem).
//
// Deliberately NO persona row: the deployment persona (soul card) plus the
// heartbeat prompt already cover it, and a "You are a coding agent" line would
// overwrite the persona.

/** One child row of the preset, in Cordis entry-list shape. */
export interface PresetEntry {
  readonly id?: string;
  readonly name?: string;
  /** `cordis:group` marker: this row nests `config` as child entries. */
  readonly group?: boolean;
  /** Isolation flags a group row may carry (kept verbatim). */
  readonly isolate?: Record<string, unknown>;
  readonly config?: unknown;
}

/** Identity, display fields and child plugins of one preset. */
export interface HeartbeatPresetDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly order: number;
  readonly plugins: readonly PresetEntry[];
}

/**
 * The bundled preset definition for `id`.
 *
 * Content = `assets/presets/heartbeat/agent.cordis.yml`: a compaction group
 * (basic + command-compact + tool-result-pruner) plus the single model-facing
 * tool `tool-web` with `fetch: false` (web_search only — no page fetching,
 * no shell, no filesystem, no subagents).
 */
export function heartbeatPresetDefinition(id: string = 'heartbeat'): HeartbeatPresetDefinition {
  return {
    id,
    name: '心跳模式',
    description: '心跳 agent 专用：仅 web_search + 上下文折叠；无 shell、无文件、无子代理。',
    order: 20,
    plugins: [
      {
        id: 'compaction',
        name: 'cordis:group',
        group: true,
        isolate: { compaction: true, toolResultPruner: true },
        config: [
          { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
          { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
          {
            id: 'tool-result-pruner',
            name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
            config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
          },
        ],
      },
      { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: false, searchTimeoutMs: 60000 } },
    ],
  };
}

/** Registration result, for the audit line and the log. */
export type PresetRegisterAction = 'registered' | 'skipped-disabled' | 'skipped-no-api' | 'error';

export interface PresetRegisterResult {
  action: PresetRegisterAction;
  id: string;
  detail?: string;
}

/** Minimal shape of the registry we call (`AgentPresetRegistry.register`). */
interface RegistrarLike {
  register?(definition: unknown): Promise<() => Promise<void>> | (() => Promise<void>);
}

/**
 * Register the bundled preset at runtime, tolerating every missing-API case.
 *
 * A host whose registry has no `register` (0.1.7-alpha.1 and other partial
 * builds) or no `agentPresets` service at all (pre-0.1.7) must NOT take the
 * host down: the heartbeat simply runs without its preset — degraded (no
 * `web_search`), which the acquire path already audits as `preset=no-api`.
 *
 * @param service The resolved `agentPresets` service, if any.
 * @param id Preset identity to register.
 * @param enabled False when the operator manages the preset themselves.
 * @returns What happened, for the audit line.
 */
export async function registerHeartbeatPreset(
  service: unknown,
  id: string = 'heartbeat',
  enabled: boolean = true,
): Promise<PresetRegisterResult> {
  if (!enabled) return { action: 'skipped-disabled', id };
  const registrar = service as RegistrarLike | undefined;
  if (registrar === undefined || registrar === null || typeof registrar.register !== 'function') {
    return { action: 'skipped-no-api', id };
  }
  try {
    await registrar.register(heartbeatPresetDefinition(id));
    return { action: 'registered', id };
  } catch (e) {
    return { action: 'error', id, detail: String(e).slice(0, 200) };
  }
}
