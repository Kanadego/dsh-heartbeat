import z from '@deepseek-ai/schemastery';

interface QuietHours {
    start: string;
    end: string;
}
interface BrowseWindow {
    start: string;
    end: string;
}
interface Policy {
    heartbeat: {
        intervalMin: number;
        idleMode: boolean;
        archiveRotatedHome: boolean;
    };
    gate: {
        maxDailySend: number;
        cooldownMinutes: number;
        quietHours: QuietHours;
    };
    browse: {
        windows: BrowseWindow[];
        minIntervalHours: number;
        maxSeedsPerVisit: number;
    };
    seeds: {
        maxActive: number;
        ttlDays: {
            news: number;
            fandom: number;
            scene: number;
            promise: number;
        };
        coldBenchDays: number;
        /** Archive-area cap (v1.9.0): gc trims archived seeds beyond this, oldest first. */
        archiveCap: number;
        retireAfterUsed: number;
        scoreWeights: {
            freshness: number;
            unused: number;
            confidence: number;
        };
    };
    profile: {
        consolidation: {
            minIntervalHours: number;
            inboxBacklog: number;
        };
        partitionCap: number;
        maxOpsPerRun: number;
        confidenceCap: {
            chat: number;
            screen: number;
            browse: number;
        };
        volatileDays: number;
        stableLowActivityDays: number;
        psyEnabled: boolean;
    };
    /** Observation depth (v1.8.0): how much of each user message enters the inbox. */
    observe: {
        maxChars: number;
        perBeat: number;
    };
    weekly: {
        enabled: boolean;
        /** v2.0 (item 5): how many past reports the store keeps and the card lists. */
        keepReports: number;
    };
    retention: {
        envPulseHours: number;
        decisionLogDays: number;
    };
}
/** Recursive merge: user values win; objects merge, arrays and scalars replace. */
declare function deepMerge<T>(base: T, override: unknown): T;

interface PathGuard {
    /** Canonical workspace boundary. */
    readonly workspace: string;
    /** Canonicalize then validate; returns the canonical path or throws. */
    assert(target: string): string;
    /** Canonicalize then validate; returns null instead of throwing. */
    check(target: string): string | null;
}

type RelocateResult = {
    action: 'relocated';
    /** Package-local tree the data came from (now deleted). */
    srcDir: string;
    dstDir: string;
    backupDir: string;
    files: number;
    bytes: number;
    /** Plaintext JSON/JSONL that does not parse (verified byte-identical). */
    warnings: string[];
    /** Paths that could not be deleted after the move (cosmetic leftovers). */
    leftovers: string[];
} | {
    action: 'skipped';
    reason: 'source-missing' | 'no-payload' | 'destination-exists';
} | {
    action: 'failed';
    stage: 'backup' | 'copy' | 'verify' | 'commit';
    problems: string[];
    /** Null when the backup itself could not be created. */
    backupDir: string | null;
};

interface WorkspacePaths {
    /** Guard boundary and the only writable tree at runtime. */
    dataDir: string;
    settingsDir: string;
    logsDir: string;
    tmpDir: string;
    exportsDir: string;
    /** Package root (where package.json lives). Read-only at runtime. */
    packageRoot: string;
    configDir: string;
    assetsDir: string;
    /**
     * Set only when a legacy package-local data dir was found: the outcome of
     * the one-time relocation. Absent for explicit dirs and fresh installs.
     */
    relocation?: RelocateResult;
}

interface OrchestratorDeps {
    ctx: {
        agents: {
            create(options: unknown): Promise<unknown>;
            resume(options: unknown): Promise<unknown>;
            roots(): unknown[];
            get(id: string): unknown;
        };
        logger: {
            info(msg: string, ...a: unknown[]): void;
            warn(msg: string, ...a: unknown[]): void;
            error(msg: string, ...a: unknown[]): void;
        };
        effect(fn: () => unknown, label?: string): () => void;
        /** Cordis service lookup (used for `agentDefaultModel`). */
        get?(name: string): unknown;
    };
    paths: WorkspacePaths;
    guard: PathGuard;
    policy: Policy;
    /** Agent preset the heartbeat agent joins (composition entry `agentPreset`). */
    agentPreset?: string;
    /** Awaited right before the preset mount: the plugin registers its preset at
     * runtime (issue #2 — the composition must not name a host package), and the
     * mount must not race that registration. Resolves at once when registration
     * was skipped or the host has no registry API. */
    presetRegistration?: () => Promise<void>;
    /** Extra tool names the engine-room allow-list should include (config
     * `extraTools`, comma-separated in the composition entry). Only names that
     * actually exist in the global layer are applied. */
    extraTools?: string[];
}

declare const name = "heartbeat";
/**
 * Host services required by the orchestrator (verified present in
 * DSH 0.1.1-rc.2 via hb-probe: agents service + agent/created + followup).
 * `settings` = the host SettingsProvider service (0.1.5): the web card's
 * rhythm edits live there. 0.1.5's strict resolution refuses undeclared
 * service access, so the name must be declared here.
 */
declare const inject: string[];
declare const Config: z<Schemastery.ObjectS<NoInfer<{
    /** Override the runtime data dir (workspace guard boundary). Empty = default (<packageRoot>/data). */
    dataDir: z<string, string, "defined">;
    /** UI-editable: heartbeat interval in minutes. 0 = use policy file / factory. */
    intervalMin: z<number, number, "defined">;
    /** UI-editable: daily expression cap. 0 = use policy file / factory. */
    maxDailySend: z<number, number, "defined">;
    /**
     * Agent preset the heartbeat agent joins (`<dshHome>/.agent-presets/<id>/`).
     * Without a preset the agent is a BARE agent: tools/prompt sections resolve
     * against the empty global layer, so it cannot even see `web_search`.
     */
    agentPreset: z<string, string, "defined">;
    /**
     * Install the bundled preset (see `agentPreset`) into the roster's user root
     * on first run, so setup needs no manual file copy. An existing preset is
     * never overwritten; set false to manage the preset entirely by hand.
     */
    installPreset: z<boolean, boolean, "defined">;
    /** Self-built time injection interval (D20, §17.6). 0 disables injection. */
    timeInjectMin: z<number, number, "defined">;
    /** IANA timezone for the injected clock; empty = process zone. */
    timeZone: z<string, string, "defined">;
    /** Statusbar master switch (D19). Off = no section/pre-step status; time injection unaffected. */
    statusbar: z<boolean, boolean, "defined">;
    /** v1.6.3 闲着模式：素材池为空时用画像话题兜底主动搭话（默认关）。 */
    idleMode: z<boolean, boolean, "defined">;
    /** v1.7.0 节省 token 模式：用户离开（闲置 ≥30 分钟）或锁屏时整跳暂停（默认关）。 */
    tokenSaver: z<boolean, boolean, "defined">;
    /** v1.8.0 账本工具：向所有日常会话 agent 注册共享账本工具（默认开）。 */
    ledgerTool: z<boolean, boolean, "defined">;
    /** v1.9.0 素材报账工具：投递后由陪伴 agent 主动报账（默认开）。 */
    seedReportTool: z<boolean, boolean, "defined">;
    /** v1.8.0 引擎室追加工具：逗号分隔的全局工具名，存在才加入白名单（bili 压缩工具自动探测，无需手填）。 */
    extraTools: z<string, string, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    /** Override the runtime data dir (workspace guard boundary). Empty = default (<packageRoot>/data). */
    dataDir: z<string, string, "defined">;
    /** UI-editable: heartbeat interval in minutes. 0 = use policy file / factory. */
    intervalMin: z<number, number, "defined">;
    /** UI-editable: daily expression cap. 0 = use policy file / factory. */
    maxDailySend: z<number, number, "defined">;
    /**
     * Agent preset the heartbeat agent joins (`<dshHome>/.agent-presets/<id>/`).
     * Without a preset the agent is a BARE agent: tools/prompt sections resolve
     * against the empty global layer, so it cannot even see `web_search`.
     */
    agentPreset: z<string, string, "defined">;
    /**
     * Install the bundled preset (see `agentPreset`) into the roster's user root
     * on first run, so setup needs no manual file copy. An existing preset is
     * never overwritten; set false to manage the preset entirely by hand.
     */
    installPreset: z<boolean, boolean, "defined">;
    /** Self-built time injection interval (D20, §17.6). 0 disables injection. */
    timeInjectMin: z<number, number, "defined">;
    /** IANA timezone for the injected clock; empty = process zone. */
    timeZone: z<string, string, "defined">;
    /** Statusbar master switch (D19). Off = no section/pre-step status; time injection unaffected. */
    statusbar: z<boolean, boolean, "defined">;
    /** v1.6.3 闲着模式：素材池为空时用画像话题兜底主动搭话（默认关）。 */
    idleMode: z<boolean, boolean, "defined">;
    /** v1.7.0 节省 token 模式：用户离开（闲置 ≥30 分钟）或锁屏时整跳暂停（默认关）。 */
    tokenSaver: z<boolean, boolean, "defined">;
    /** v1.8.0 账本工具：向所有日常会话 agent 注册共享账本工具（默认开）。 */
    ledgerTool: z<boolean, boolean, "defined">;
    /** v1.9.0 素材报账工具：投递后由陪伴 agent 主动报账（默认开）。 */
    seedReportTool: z<boolean, boolean, "defined">;
    /** v1.8.0 引擎室追加工具：逗号分隔的全局工具名，存在才加入白名单（bili 压缩工具自动探测，无需手填）。 */
    extraTools: z<string, string, "defined">;
}>>, "plain">;
interface HeartbeatConfig {
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
declare function apply(ctx: OrchestratorDeps['ctx'] & {
    get(name: string): unknown;
    /** Cordis lazy service declaration: callback runs once the named services mount. */
    inject(services: string[], callback: (scoped: unknown) => void): void;
    /** Cordis event subscription (pre-step waterfall etc.); returns a disposer. */
    on(event: string, listener: (payload: never, next: () => Promise<unknown>) => Promise<unknown>, opts?: {
        prepend?: boolean;
    }): unknown;
}, config?: HeartbeatConfig): void;

export { Config, type HeartbeatConfig, apply, deepMerge, inject, name };
