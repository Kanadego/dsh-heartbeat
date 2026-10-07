import { Volatile, Dict, Binary } from './array.ts';

/** The Standard Typed interface. This is a base type extended by other specs. */
interface StandardTypedV1<Input = unknown, Output = Input> {
    /** The Standard properties. */
    readonly "~standard": StandardTypedV1.Props<Input, Output>;
}
declare namespace StandardTypedV1 {
    /** The Standard Typed properties interface. */
    interface Props<Input = unknown, Output = Input> {
        /** The version number of the standard. */
        readonly version: 1;
        /** The vendor name of the schema library. */
        readonly vendor: string;
        /** Inferred types associated with the schema. */
        readonly types?: Types<Input, Output> | undefined;
    }
    /** The Standard Typed types interface. */
    interface Types<Input = unknown, Output = Input> {
        /** The input type of the schema. */
        readonly input: Input;
        /** The output type of the schema. */
        readonly output: Output;
    }
    /** Infers the input type of a Standard Typed. */
    type InferInput<Schema extends StandardTypedV1> = NonNullable<Schema["~standard"]["types"]>["input"];
    /** Infers the output type of a Standard Typed. */
    type InferOutput<Schema extends StandardTypedV1> = NonNullable<Schema["~standard"]["types"]>["output"];
}
/** The Standard Schema interface. */
interface StandardSchemaV1<Input = unknown, Output = Input> {
    /** The Standard Schema properties. */
    readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}
declare namespace StandardSchemaV1 {
    /** The Standard Schema properties interface. */
    interface Props<Input = unknown, Output = Input> extends StandardTypedV1.Props<Input, Output> {
        /** Validates unknown input values. */
        readonly validate: (value: unknown, options?: StandardSchemaV1.Options | undefined) => Result<Output> | Promise<Result<Output>>;
    }
    /** The result interface of the validate function. */
    type Result<Output> = SuccessResult<Output> | FailureResult;
    /** The result interface if validation succeeds. */
    interface SuccessResult<Output> {
        /** The typed output value. */
        readonly value: Output;
        /** A falsy value for `issues` indicates success. */
        readonly issues?: undefined;
    }
    interface Options {
        /** Explicit support for additional vendor-specific parameters, if needed. */
        readonly libraryOptions?: Record<string, unknown> | undefined;
    }
    /** The result interface if validation fails. */
    interface FailureResult {
        /** The issues of failed validation. */
        readonly issues: ReadonlyArray<Issue>;
    }
    /** The issue interface of the failure output. */
    interface Issue {
        /** The error message of the issue. */
        readonly message: string;
        /** The path of the issue, if any. */
        readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
    }
    /** The path segment interface of the issue. */
    interface PathSegment {
        /** The key representing a path segment. */
        readonly key: PropertyKey;
    }
    /** The Standard types interface. */
    interface Types<Input = unknown, Output = Input> extends StandardTypedV1.Types<Input, Output> {
    }
    /** Infers the input type of a Standard. */
    type InferInput<Schema extends StandardTypedV1> = StandardTypedV1.InferInput<Schema>;
    /** Infers the output type of a Standard. */
    type InferOutput<Schema extends StandardTypedV1> = StandardTypedV1.InferOutput<Schema>;
}

declare const kSchema: unique symbol;
declare global {
    namespace Schemastery {
        /** Convert primitive constructors, constants, and existing schemas into a schema type. */
        type From<X> = X extends string | number | boolean ? Schema<X> : X extends Schema<any, any, SchemaMode> ? X : X extends typeof String ? Schema<string> : X extends typeof Number ? Schema<number> : X extends typeof Boolean ? Schema<boolean> : X extends typeof Function ? Schema<Function, (...args: any[]) => any> : X extends Constructor<infer S> ? Schema<S> : never;
        type TypeS1<X> = X extends Schema<infer S, infer _T, infer _M> ? S : never;
        type Inverse<X> = X extends Schema<infer _S, infer T, infer M> ? (arg: SchemaOutput<T, M>) => void : never;
        /** Input type accepted by a schema-like value. */
        type TypeS<X> = TypeS1<From<X>>;
        /** Output type returned by a schema-like value after validation. */
        type TypeT<X> = ReturnType<From<X>>;
        /** Resolver callback used by custom schema types registered with `Schema.extend()`. */
        type Resolve = (data: any, schema: Schema, options: Options, strict?: boolean) => [any, any?];
        /** Input type accepted by one schema in an intersection. */
        type IntersectS<X> = From<X> extends Schema<infer S, infer _T, infer _M> ? S : never;
        /** Output type returned by one schema in an intersection. */
        type IntersectT<X> = Inverse<From<X>> extends ((arg: infer T) => void) ? T : never;
        type TupleS<X extends readonly any[]> = X extends readonly [infer L, ...infer R] ? [TypeS<L>?, ...TupleS<R>] : any[];
        type TupleT<X extends readonly any[]> = X extends readonly [infer L, ...infer R] ? [TypeT<L>?, ...TupleT<R>] : any[];
        type ObjectS<X extends Dict> = {
            [K in keyof X]?: TypeS<X[K]> | null;
        } & Dict;
        type ObjectT<X extends Dict> = {
            [K in keyof X]: TypeT<X[K]>;
        } & Dict;
        type Constructor<T = any> = new (...args: any[]) => T;
        /** Static constructor and factory methods exposed by the default `Schema` export. */
        interface Static {
            <T = any>(options: Partial<Schema<T>>): Schema<T>;
            new <T = any>(options: Partial<Schema<T>>): Schema<T>;
            prototype: Schema;
            /** Validate a value against a schema node and return `[output, adaptedInput?]`. */
            resolve: Resolve;
            /** Infer a schema from a primitive value, constructor, or existing schema. */
            from<X = any>(source?: X): From<X>;
            /** Register a resolver for a custom schema `type`. */
            extend(type: string, resolve: Resolve): void;
            /** Accept any value without validation. */
            any<T = any>(): Schema<T>;
            /** Accept only nullable input. */
            never(): Schema<never>;
            /** Accept exactly one constant value. */
            const<const T>(value: T): Schema<T>;
            /** Accept strings, with optional metadata constraints added by instance methods. */
            string(): Schema<string>;
            /** Accept numbers, with optional range and step constraints. */
            number(): Schema<number>;
            /** Accept non-negative integer numbers. */
            natural(): Schema<number>;
            /** Accept a number between 0 and 1 and mark it as a slider. */
            percent(): Schema<number>;
            /** Accept booleans. */
            boolean(): Schema<boolean>;
            /** Accept `Date` instances or parse datetime strings into `Date` objects. */
            date(): Schema<string | Date, Date>;
            /** Accept `RegExp` instances or parse strings into regular expressions. */
            regExp(flag?: string): Schema<string | RegExp, RegExp>;
            /** Accept binary sources and normalize them to `ArrayBufferLike`. */
            arrayBuffer(): Schema<Binary.Source, ArrayBufferLike>;
            arrayBuffer(encoding: 'hex' | 'base64'): Schema<Binary.Source | string, ArrayBufferLike>;
            /** Accept a numeric bitset or string keys and normalize to a number. */
            bitset<K extends string>(bits: Partial<Record<K, number>>): Schema<number | readonly K[], number>;
            /** Accept functions. */
            function(): Schema<Function, (...args: any[]) => any>;
            /** Accept instances of a constructor or objects whose constructor name matches. */
            is(constructor: string): Schema;
            is<T>(constructor: Constructor<T>): Schema<T>;
            /** Accept arrays whose elements match `inner`. */
            array<X>(inner: X): Schema<TypeS<X>[], TypeT<X>[]>;
            /** Accept plain objects with values matching `inner` and optional key schema. */
            dict<X, Y extends Schema<any, string> = Schema<string>>(inner: X, sKey?: Y): Schema<Dict<TypeS<X>, TypeS<Y>>, Dict<TypeT<X>, TypeT<Y>>>;
            /** Accept tuple arrays where each index matches the corresponding schema. */
            tuple<const X extends readonly any[]>(list: X): Schema<TupleS<X>, TupleT<X>>;
            /** Accept plain objects; infer fields from the dictionary, not the enclosing schema's output type. */
            object<X extends Dict>(dict: X): Schema<ObjectS<NoInfer<X>>, ObjectT<NoInfer<X>>>;
            /** Accept values matching at least one schema in `list`. */
            union<const X>(list: readonly X[]): Schema<TypeS<X>, TypeT<X>>;
            /** Accept values matching every schema in `list`, merging object outputs. */
            intersect<const X>(list: readonly X[]): Schema<IntersectS<X>, IntersectT<X>>;
            /** Validate with `inner`, then convert the result with `callback`. */
            transform<X, T>(inner: X, callback: (value: TypeS<X>, options: Schemastery.Options) => T, preserve?: boolean): Schema<TypeS<X>, T>;
            /** Defer construction of a recursive schema until validation or serialization. */
            lazy<X extends Schema<any, any, SchemaMode>>(callback: () => X): X;
            ValidationError: typeof ValidationError;
        }
        /** Runtime validation options shared by all schema calls. */
        interface Options {
            /** Remove invalid object properties instead of throwing when possible. */
            autofix?: boolean;
            /** Skip validation for selected values and schema nodes. */
            ignore?(data: any, schema: Schema): boolean;
            /** Path used to format nested validation errors. */
            path?: (keyof any)[];
        }
        /** UI and validation metadata attached by schema builder methods. */
        interface Meta<T = any> {
            default?: T extends {} ? Partial<T> : T;
            required?: boolean;
            /** Parse this node as a stable config reference; its type and UI metadata remain unchanged. */
            volatile?: boolean;
            disabled?: boolean;
            collapse?: boolean;
            badges?: {
                text: string;
                type: string;
            }[];
            hidden?: boolean;
            loose?: boolean;
            role?: string;
            extra?: any;
            link?: string;
            description?: string | Dict<string>;
            comment?: string;
            pattern?: {
                source: string;
                flags?: string;
            };
            max?: number;
            min?: number;
            step?: number;
        }
    }
    /** Callable schema instance that validates input and returns normalized output. */
    interface Schemastery<S = any, T = S, Mode extends SchemaMode = 'plain'> {
        (data?: S | null, options?: Schemastery.Options): SchemaOutput<T, Mode>;
        new (data?: S | null, options?: Schemastery.Options): SchemaOutput<T, Mode>;
        [kSchema]: true;
        uid: number;
        meta: Schemastery.Meta<T>;
        type: string;
        sKey?: Schema;
        inner?: Schema;
        list?: Schema[];
        dict?: Dict<Schema>;
        bits?: Dict<number>;
        callback?: Function;
        constructor?: string | Function;
        builder?: Function;
        value?: T;
        refs?: Dict<Schema>;
        preserve?: boolean;
        '~standard': StandardSchemaV1.Props;
        /** Format this schema as a compact TypeScript-like type string. */
        toString(inline?: boolean): string;
        /** Serialize this schema, preserving shared and recursive references. */
        toJSON(): Schema<S, T, Mode>;
        /** Mark nullable input as invalid unless a default supplies a fallback. */
        required<R extends boolean = true>(value?: R): Schema<S, T, SetRequired<Mode, R>>;
        /**
         * Parse this config field as a stable reference containing immutable data.
         * @returns a schema whose output supports get(), including when the field is absent.
         */
        volatile(): Schema<NoInfer<S>, NoInfer<T>, Mode extends 'defined' | 'volatile-defined' ? 'volatile-defined' : 'volatile'>;
        /** Hide this schema node from UI renderers. */
        hidden(value?: boolean): Schema<S, T, Mode>;
        /** Return the default value instead of throwing when validation fails. */
        loose(value?: boolean): Schema<S, T, Mode>;
        /** Attach a renderer role and optional role-specific metadata. */
        role(text: string, extra?: any): Schema<S, T, Mode>;
        /** Attach an external documentation link. */
        link(link: string): Schema<S, T, Mode>;
        /** Set the fallback value used for nullable input. */
        default(value: T | NoInfer<Partial<S>>): Schema<S, T, SetRequired<Mode, true>>;
        /** Attach an auxiliary comment for documentation or form UIs. */
        comment(text: string): Schema<S, T, Mode>;
        /** Attach a localized or plain description for documentation or form UIs. */
        description(text: string): Schema<S, T, Mode>;
        /** Mark this schema node as disabled for form UIs. */
        disabled(value?: boolean): Schema<S, T, Mode>;
        /** Request collapsed rendering for nested form UIs. */
        collapse(value?: boolean): Schema<S, T, Mode>;
        /** Add a deprecated badge to this schema node. */
        deprecated(): Schema<S, T, Mode>;
        /** Add an experimental badge to this schema node. */
        experimental(): Schema<S, T, Mode>;
        /** Require strings to match a regular expression. */
        pattern(regexp: RegExp): Schema<S, T, Mode>;
        /** Set an inclusive maximum for numbers or collection lengths. */
        max(value: number): Schema<S, T, Mode>;
        /** Set an inclusive minimum for numbers or collection lengths. */
        min(value: number): Schema<S, T, Mode>;
        /** Set the numeric increment constraint. */
        step(value: number): Schema<S, T, Mode>;
        /** Add or replace an object property schema. */
        set(key: string, value: Schema): Schema<S, T, Mode>;
        /** Append a tuple, union, or intersection member schema. */
        push(value: Schema): Schema<S, T, Mode>;
        /** Remove values equal to schema defaults from normalized output. */
        simplify(value?: any): any;
        /** Return a schema clone with descriptions merged from locale messages. */
        i18n(messages: Dict): Schema<S, T, Mode>;
        /** Attach arbitrary metadata consumed by form renderers and downstream tools. */
        extra<K extends keyof Schemastery.Meta>(key: K, value: Schemastery.Meta[K]): Schema<S, T, Mode>;
    }
}
declare class ValidationError extends TypeError {
    options: Schemastery.Options;
    name: string;
    constructor(message: string, options: Schemastery.Options);
    static is(error: any): error is ValidationError;
}
type SchemaMode = 'plain' | 'defined' | 'volatile' | 'volatile-defined';
type SchemaOutput<T, M extends SchemaMode> = M extends 'volatile' ? Volatile<T | undefined> : M extends 'volatile-defined' ? Volatile<T> : T;
type SetRequired<M extends SchemaMode, R extends boolean> = M extends 'volatile' | 'volatile-defined' ? R extends true ? 'volatile-defined' : 'volatile' : R extends true ? 'defined' : 'plain';
type Schema<S = any, T = S, Mode extends SchemaMode = 'plain'> = Schemastery<S, T, Mode>;
declare const Schema: Schemastery.Static;
//# sourceMappingURL=index.d.ts.map

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
declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    /** Override the runtime data dir (workspace guard boundary). Empty = default (<packageRoot>/data). */
    dataDir: Schema<string, string, "defined">;
    /** UI-editable: heartbeat interval in minutes. 0 = use policy file / factory. */
    intervalMin: Schema<number, number, "defined">;
    /** UI-editable: daily expression cap. 0 = use policy file / factory. */
    maxDailySend: Schema<number, number, "defined">;
    /**
     * Agent preset the heartbeat agent joins (`<dshHome>/.agent-presets/<id>/`).
     * Without a preset the agent is a BARE agent: tools/prompt sections resolve
     * against the empty global layer, so it cannot even see `web_search`.
     */
    agentPreset: Schema<string, string, "defined">;
    /**
     * Install the bundled preset (see `agentPreset`) into the roster's user root
     * on first run, so setup needs no manual file copy. An existing preset is
     * never overwritten; set false to manage the preset entirely by hand.
     */
    installPreset: Schema<boolean, boolean, "defined">;
    /** Self-built time injection interval (D20, §17.6). 0 disables injection. */
    timeInjectMin: Schema<number, number, "defined">;
    /** IANA timezone for the injected clock; empty = process zone. */
    timeZone: Schema<string, string, "defined">;
    /** Statusbar master switch (D19). Off = no section/pre-step status; time injection unaffected. */
    statusbar: Schema<boolean, boolean, "defined">;
    /** v1.6.3 闲着模式：素材池为空时用画像话题兜底主动搭话（默认关）。 */
    idleMode: Schema<boolean, boolean, "defined">;
    /** v1.7.0 节省 token 模式：用户离开（闲置 ≥30 分钟）或锁屏时整跳暂停（默认关）。 */
    tokenSaver: Schema<boolean, boolean, "defined">;
    /** v1.8.0 账本工具：向所有日常会话 agent 注册共享账本工具（默认开）。 */
    ledgerTool: Schema<boolean, boolean, "defined">;
    /** v1.9.0 素材报账工具：投递后由陪伴 agent 主动报账（默认开）。 */
    seedReportTool: Schema<boolean, boolean, "defined">;
    /** v1.8.0 引擎室追加工具：逗号分隔的全局工具名，存在才加入白名单（bili 压缩工具自动探测，无需手填）。 */
    extraTools: Schema<string, string, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    /** Override the runtime data dir (workspace guard boundary). Empty = default (<packageRoot>/data). */
    dataDir: Schema<string, string, "defined">;
    /** UI-editable: heartbeat interval in minutes. 0 = use policy file / factory. */
    intervalMin: Schema<number, number, "defined">;
    /** UI-editable: daily expression cap. 0 = use policy file / factory. */
    maxDailySend: Schema<number, number, "defined">;
    /**
     * Agent preset the heartbeat agent joins (`<dshHome>/.agent-presets/<id>/`).
     * Without a preset the agent is a BARE agent: tools/prompt sections resolve
     * against the empty global layer, so it cannot even see `web_search`.
     */
    agentPreset: Schema<string, string, "defined">;
    /**
     * Install the bundled preset (see `agentPreset`) into the roster's user root
     * on first run, so setup needs no manual file copy. An existing preset is
     * never overwritten; set false to manage the preset entirely by hand.
     */
    installPreset: Schema<boolean, boolean, "defined">;
    /** Self-built time injection interval (D20, §17.6). 0 disables injection. */
    timeInjectMin: Schema<number, number, "defined">;
    /** IANA timezone for the injected clock; empty = process zone. */
    timeZone: Schema<string, string, "defined">;
    /** Statusbar master switch (D19). Off = no section/pre-step status; time injection unaffected. */
    statusbar: Schema<boolean, boolean, "defined">;
    /** v1.6.3 闲着模式：素材池为空时用画像话题兜底主动搭话（默认关）。 */
    idleMode: Schema<boolean, boolean, "defined">;
    /** v1.7.0 节省 token 模式：用户离开（闲置 ≥30 分钟）或锁屏时整跳暂停（默认关）。 */
    tokenSaver: Schema<boolean, boolean, "defined">;
    /** v1.8.0 账本工具：向所有日常会话 agent 注册共享账本工具（默认开）。 */
    ledgerTool: Schema<boolean, boolean, "defined">;
    /** v1.9.0 素材报账工具：投递后由陪伴 agent 主动报账（默认开）。 */
    seedReportTool: Schema<boolean, boolean, "defined">;
    /** v1.8.0 引擎室追加工具：逗号分隔的全局工具名，存在才加入白名单（bili 压缩工具自动探测，无需手填）。 */
    extraTools: Schema<string, string, "defined">;
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
