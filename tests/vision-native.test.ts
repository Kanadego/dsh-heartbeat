// Native vision engine tests (v2.2.1-native.1): engine resolution, the
// native → ModLens fallback contract, truncation bounds, the privacy rule
// (failure keeps the picture AND the titles away from the caller), and the
// "use then burn" discipline on every path. No ModLens install, no network,
// no real agent: the host turn and the CLI spawn are both fakes.

import { sandboxDir } from './_sandbox.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import { encryptFile, resetVaultKeyCacheForTest, saveJson } from '../src/vault/vault.js';
import { BeatAbortedError, nativeVisionTurn, type OrchestratorDeps } from '../src/core/orchestrator.js';
import { screenJpgPath, screenJsonPath, screenStampPath } from '../src/screen/screenpulse.js';
import {
  DEFAULT_VISION_ENGINE,
  NATIVE_VISION_PROMPT,
  describeScreenVision,
  readVisionSettings,
  resolveVisionEngine,
  resolveVisionEnginePrecedence,
  type NativeVisionTurn,
} from '../src/screen/vision.js';
import { Config } from '../src/index.js';

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;

beforeEach(() => {
  sandbox = sandboxDir('hb-vision-native-');
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  resetVaultKeyCacheForTest();
  guard = createPathGuard(workspace().dataDir);
});

after(() => {
  resetWorkspaceForTest();
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetVaultKeyCacheForTest();
});

const STAMP_AT = '2026-11-14T11:00:00.000Z';

/** Lay down the same triple the collector commits (encrypted jpg + screen.json
 *  + screen.capture) — vision only accepts a shot stamped for THIS beat. */
function writeCurrentShot(plain = 'fakejpeg'): void {
  const paths = workspace();
  const tmpShot = path.join(paths.tmpDir, 'plain.jpg');
  fs.writeFileSync(tmpShot, plain);
  encryptFile(guard, tmpShot, screenJpgPath(paths));
  fs.rmSync(tmpShot, { force: true });
  saveJson(guard, screenJsonPath(paths), {
    title: '',
    process: '',
    pid: 0,
    rect: null,
    screen: null,
    focus: { title: '', process: '', pid: 0 },
    windows: [],
    captured_at: STAMP_AT,
  });
  fs.writeFileSync(screenStampPath(paths), STAMP_AT, 'utf8');
}

function dropCurrentShot(): void {
  const paths = workspace();
  fs.rmSync(screenJpgPath(paths), { force: true });
  fs.rmSync(screenStampPath(paths), { force: true });
}

interface TurnCall {
  shotPath: string;
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** the host turn must receive a path that still exists (it reads the bytes). */
  readable: boolean;
}

function fakeTurn(impl: (shotPath: string, prompt: string) => Promise<string>): {
  turn: NativeVisionTurn;
  calls: TurnCall[];
} {
  const calls: TurnCall[] = [];
  const turn: NativeVisionTurn = async (shotPath, prompt, opts) => {
    calls.push({ shotPath, prompt, timeoutMs: opts.timeoutMs, signal: opts.signal, readable: fs.existsSync(shotPath) });
    return impl(shotPath, prompt);
  };
  return { turn, calls };
}

/** A stub ModLens entry that exists on disk and a spawnCli that writes the
 *  given summary (or fails), recording that it was called. */
function fakeCli(opts: { summary?: string; code?: number; throws?: boolean } = {}): {
  mainPath: string;
  spawnCli: (cmd: string, args: string[], timeoutMs: number, signal?: AbortSignal) => Promise<{ code: number | null; stderr?: string }>;
  calls: string[][];
} {
  const mainPath = path.join(workspace().tmpDir, 'fake-modlens-main.js');
  fs.writeFileSync(mainPath, '// stub');
  const calls: string[][] = [];
  const spawnCli = async (_cmd: string, args: string[]) => {
    calls.push(args);
    if (opts.throws === true) throw new Error('modlens timeout (115000ms)');
    if (opts.code !== undefined && opts.code !== 0) return { code: opts.code };
    const out = args[args.indexOf('-o') + 1]!;
    fs.writeFileSync(out, JSON.stringify({ result: { summary: opts.summary ?? '(modlens) 在写代码' } }));
    return { code: 0 };
  };
  return { mainPath, spawnCli, calls };
}

const unusedCli = (): { mainPath: string; spawnCli: () => Promise<{ code: number }>; calls: string[][] } => {
  const mainPath = path.join(workspace().tmpDir, 'unused-modlens-main.js');
  fs.writeFileSync(mainPath, '// stub');
  const calls: string[][] = [];
  return {
    mainPath,
    spawnCli: async () => { calls.push([]); return { code: 0 }; },
    calls,
  };
};

function leftoverPlaintext(): string[] {
  return fs.readdirSync(workspace().tmpDir).filter((f) => f.startsWith('screen.view.'));
}

// ── engine resolution ────────────────────────────────────────────────────

test('engine: absent reads as auto, the two literals survive, anything else reads as auto', () => {
  assert.equal(DEFAULT_VISION_ENGINE, 'auto');
  assert.equal(resolveVisionEngine(undefined), 'auto');
  assert.equal(resolveVisionEngine('native'), 'native');
  assert.equal(resolveVisionEngine('modlens'), 'modlens');
  // documented lenient choice: a typo must not switch vision off.
  assert.equal(resolveVisionEngine('bogus'), 'auto');
  assert.equal(resolveVisionEngine(''), 'auto');
  assert.equal(resolveVisionEngine('NATIVE'), 'auto');
  assert.equal(resolveVisionEngine(7), 'auto');
});

test('engine: vision.json engine is read, and a missing/absent file stays auto', () => {
  const paths = workspace();
  // no file at all → no engine key (the router then falls back to auto)
  assert.equal(readVisionSettings(guard, paths).engine, undefined);
  fs.writeFileSync(path.join(paths.settingsDir, 'vision.json'), JSON.stringify({ engine: 'native' }));
  assert.equal(readVisionSettings(guard, paths).engine, 'native');
  fs.writeFileSync(path.join(paths.settingsDir, 'vision.json'), JSON.stringify({ engine: 'modlens', provider: 'openai' }));
  const read = readVisionSettings(guard, paths);
  assert.equal(read.engine, 'modlens');
  assert.equal(read.provider, 'openai');
  fs.writeFileSync(path.join(paths.settingsDir, 'vision.json'), JSON.stringify({ engine: 'whatever' }));
  assert.equal(readVisionSettings(guard, paths).engine, 'auto');
});

// ── native engine ────────────────────────────────────────────────────────

test('native: default (auto) engine asks the agent first and returns its line', async () => {
  writeCurrentShot();
  const native = fakeTurn(async () => '在 IDE 里写测试');
  const cli = unusedCli();
  const vision = await describeScreenVision(guard, workspace(), {
    moduleUrl: import.meta.url,
    turn: native.turn,
    mainPath: cli.mainPath,
    spawnCli: cli.spawnCli,
  });
  assert.equal(vision.ok, true);
  assert.equal(vision.summary, '在 IDE 里写测试');
  assert.equal(vision.engine, 'native');
  assert.equal(native.calls.length, 1);
  assert.equal(native.calls[0]!.readable, true, 'the host turn reads a live plaintext file');
  assert.equal(native.calls[0]!.prompt, NATIVE_VISION_PROMPT);
  assert.equal(native.calls[0]!.timeoutMs, 120_000);
  assert.equal(cli.calls.length, 0, 'ModLens stays unused when native answers');
  assert.deepEqual(leftoverPlaintext(), [], 'plaintext burned after use');
});

test('native: the summary is capped at 300 characters', async () => {
  writeCurrentShot();
  const native = fakeTurn(async () => 'x'.repeat(500));
  const vision = await describeScreenVision(guard, workspace(), { moduleUrl: import.meta.url, turn: native.turn });
  assert.equal(vision.ok, true);
  assert.equal(vision.summary!.length, 300);
});

test('native: settings.prompt overrides the built-in vision prompt', async () => {
  writeCurrentShot();
  const paths = workspace();
  fs.writeFileSync(path.join(paths.settingsDir, 'vision.json'), JSON.stringify({ engine: 'native', prompt: '只看一眼，一句话。' }));
  const native = fakeTurn(async () => '在开船');
  const vision = await describeScreenVision(guard, paths, { moduleUrl: import.meta.url, turn: native.turn });
  assert.equal(vision.ok, true);
  assert.equal(native.calls[0]!.prompt, '只看一眼，一句话。');
});

test('native: a throwing turn is a failure, reports <=160 chars, and scrubs the shot path', async () => {
  writeCurrentShot();
  let leaked = '';
  const native = fakeTurn(async (shotPath) => {
    leaked = shotPath;
    throw new Error(`EACCES: cannot read ${shotPath} ${'z'.repeat(400)}`);
  });
  const vision = await describeScreenVision(guard, workspace(), {
    moduleUrl: import.meta.url,
    engine: 'native',
    turn: native.turn,
  });
  assert.equal(vision.ok, false);
  assert.equal(vision.summary, null);
  assert.equal(vision.engine, 'native');
  assert.ok(vision.error!.length <= 160, 'error text is capped to 160 chars');
  assert.ok(!vision.error!.includes(leaked), 'the picture path never reaches the audit text');
  assert.ok(vision.error!.includes('<screenshot>'), 'the path is replaced by a placeholder');
  assert.deepEqual(leftoverPlaintext(), [], 'plaintext burned even when the turn fails');
});

// ── engine routing / fallback ────────────────────────────────────────────

test('auto: a failing native read falls back to ModLens', async () => {
  writeCurrentShot();
  const native = fakeTurn(async () => { throw new Error('model error: NO_ADAPTER'); });
  const cli = fakeCli({ summary: '(modlens) 在开船' });
  const vision = await describeScreenVision(guard, workspace(), {
    moduleUrl: import.meta.url,
    turn: native.turn,
    mainPath: cli.mainPath,
    spawnCli: cli.spawnCli,
  });
  assert.equal(vision.ok, true);
  assert.equal(vision.summary, '(modlens) 在开船');
  assert.equal(vision.engine, 'modlens');
  assert.equal(native.calls.length, 1, 'native was tried first');
  assert.equal(cli.calls.length, 1, 'ModLens ran as the fallback');
  assert.deepEqual(leftoverPlaintext(), [], 'every plaintext was burned');
});

test('auto: both engines failing stays the old failure shape (ok:false, no summary)', async () => {
  writeCurrentShot();
  const native = fakeTurn(async () => { throw new Error('native boom'); });
  const cli = fakeCli({ code: 3 });
  const vision = await describeScreenVision(guard, workspace(), {
    moduleUrl: import.meta.url,
    turn: native.turn,
    mainPath: cli.mainPath,
    spawnCli: cli.spawnCli,
  });
  assert.equal(vision.ok, false);
  assert.equal(vision.summary, null);
  assert.equal(vision.engine, 'modlens');
  assert.match(vision.error!, /exit 3/);
  assert.equal(native.calls.length, 1);
  assert.equal(cli.calls.length, 1);
});

test('native: engine=native never spawns ModLens, even when the read fails', async () => {
  writeCurrentShot();
  const native = fakeTurn(async () => { throw new Error('timeout'); });
  const cli = unusedCli();
  const vision = await describeScreenVision(guard, workspace(), {
    moduleUrl: import.meta.url,
    engine: 'native',
    turn: native.turn,
    mainPath: cli.mainPath,
    spawnCli: cli.spawnCli,
  });
  assert.equal(vision.ok, false);
  assert.equal(vision.summary, null);
  assert.equal(vision.engine, 'native');
  assert.equal(cli.calls.length, 0, 'engine=native has no fallback');
});

test('modlens: engine=modlens never runs the native turn', async () => {
  writeCurrentShot();
  const native = fakeTurn(async () => '不该被调用');
  const cli = fakeCli({ summary: '(modlens) 在写文档' });
  const vision = await describeScreenVision(guard, workspace(), {
    moduleUrl: import.meta.url,
    engine: 'modlens',
    turn: native.turn,
    mainPath: cli.mainPath,
    spawnCli: cli.spawnCli,
  });
  assert.equal(vision.ok, true);
  assert.equal(vision.summary, '(modlens) 在写文档');
  assert.equal(vision.engine, 'modlens');
  assert.equal(native.calls.length, 0);
});

test('auto: a host without the native channel (no turn) degrades to ModLens', async () => {
  writeCurrentShot();
  const cli = fakeCli({ summary: '(modlens) 在读网页' });
  const vision = await describeScreenVision(guard, workspace(), {
    moduleUrl: import.meta.url,
    mainPath: cli.mainPath,
    spawnCli: cli.spawnCli,
  });
  assert.equal(vision.ok, true);
  assert.equal(vision.engine, 'modlens');
  assert.equal(cli.calls.length, 1);
});

// ── no shot this beat (privacy + shape) ──────────────────────────────────

test('no shot this beat: native never runs, auto still fails closed', async () => {
  writeCurrentShot();
  dropCurrentShot();
  const native = fakeTurn(async () => '在玩游戏');
  const cli = fakeCli({ summary: '不该有画面' });
  const auto = await describeScreenVision(guard, workspace(), {
    moduleUrl: import.meta.url,
    turn: native.turn,
    mainPath: cli.mainPath,
    spawnCli: cli.spawnCli,
  });
  assert.equal(auto.ok, false);
  assert.equal(auto.summary, null);
  assert.equal(native.calls.length, 0, 'no plaintext is unlocked when the shot is stale');
  assert.match(auto.error!, /no screenshot/);
  // engine=native reports the same closed failure without asking the agent
  const only = await describeScreenVision(guard, workspace(), {
    moduleUrl: import.meta.url,
    engine: 'native',
    turn: native.turn,
  });
  assert.equal(only.ok, false);
  assert.equal(only.summary, null);
  assert.equal(only.engine, 'native');
  assert.match(only.error!, /no screenshot/);
  assert.equal(native.calls.length, 0);
});

test('native: an empty answer is a failure, not a summary', async () => {
  writeCurrentShot();
  const native = fakeTurn(async () => '   ');
  const vision = await describeScreenVision(guard, workspace(), {
    moduleUrl: import.meta.url,
    engine: 'native',
    turn: native.turn,
  });
  assert.equal(vision.ok, false);
  assert.equal(vision.summary, null);
  assert.match(vision.error!, /no summary/);
});
// ── the host side (orchestrator.nativeVisionTurn) ────────────────────────
// The turn is where the picture becomes a MESSAGE, so these tests pin the
// things that would silently make the native engine fake a scene: the image
// part must be built through the host channel, and a model route that cannot
// take images must fail BEFORE a turn is spent.

interface HostHarness {
  agent: {
    id: string;
    options: { provider: string; model: string };
    session: { id: string; events: unknown[]; snapshotEvents: () => unknown[] };
    followup: (message: unknown) => void;
    whenIdle: () => Promise<void>;
  };
  messages: { role?: string; content?: unknown[]; source?: { kind?: string } }[];
  saved: { data: Uint8Array; mediaType: string; name?: string }[];
}

function fakeHost(turnText: string | null, idle: 'settle' | 'hang' = 'settle'): HostHarness {
  const events: unknown[] = [];
  const messages: HostHarness['messages'] = [];
  const saved: HostHarness['saved'] = [];
  const agent: HostHarness['agent'] = {
    id: 'a1',
    options: { provider: 'deepseek', model: 'deepseek-flash' },
    session: { id: 's1', events, snapshotEvents: () => events.slice() },
    followup: (message: unknown) => {
      messages.push(message as HostHarness['messages'][number]);
      if (turnText !== null) {
        events.push({ type: 'assistant/message', data: { content: [{ type: 'text', text: turnText }] } });
      }
    },
    whenIdle: () => (idle === 'hang' ? new Promise<void>(() => {}) : Promise.resolve()),
  };
  return { agent, messages, saved };
}

/** deps with the two host services the turn probes (attachments, llm). */
function hostDeps(services: { attachments?: unknown; llm?: unknown }): OrchestratorDeps {
  return {
    paths: workspace(),
    ctx: {
      get: (name: string) => (name === 'attachments' ? services.attachments : name === 'llm' ? services.llm : undefined),
    },
  } as unknown as OrchestratorDeps;
}

const imageRef = { attachmentId: 'sha256:abc123', mediaType: 'image/jpeg', bytes: 4, width: 8, height: 8, name: 'heartbeat-screen.jpg' };

test('nativeVisionTurn: the picture becomes an image content part on a heartbeat user message', async () => {
  const host = fakeHost('在 IDE 里写测试');
  const shot = path.join(workspace().tmpDir, 'shot-native.jpg');
  fs.writeFileSync(shot, 'JPEG');
  const saveImage = async (input: { data: Uint8Array; mediaType: string; name?: string }) => {
    host.saved.push(input);
    return imageRef;
  };
  const turn = await nativeVisionTurn(
    hostDeps({ attachments: { saveImage }, llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) } }),
    host.agent as never,
    shot,
    '看这张图',
    { timeoutMs: 5_000 },
  );
  assert.equal(turn, '在 IDE 里写测试');
  assert.equal(host.saved.length, 1);
  assert.equal(host.saved[0]!.mediaType, 'image/jpeg');
  assert.deepEqual(Buffer.from(host.saved[0]!.data), Buffer.from('JPEG'), 'the plaintext bytes are what the host stores');
  const message = host.messages[0]!;
  assert.equal(message.role, 'user');
  assert.equal(message.source!.kind, 'heartbeat');
  const parts = message.content as { type: string; text?: string; attachment?: { attachmentId?: string } }[];
  assert.deepEqual(parts[0], { type: 'text', text: '看这张图' });
  assert.equal(parts[1]!.type, 'image');
  assert.equal(parts[1]!.attachment!.attachmentId, 'sha256:abc123');
});

test('nativeVisionTurn: a model route without image input fails before any turn is spent', async () => {
  const host = fakeHost('编出来的画面');
  const shot = path.join(workspace().tmpDir, 'shot-text-only.jpg');
  fs.writeFileSync(shot, 'JPEG');
  let saves = 0;
  await assert.rejects(
    nativeVisionTurn(
      hostDeps({
        attachments: { saveImage: async () => { saves += 1; return imageRef; } },
        llm: { resolveModelInfo: async () => ({ inputModalities: ['text'] }) },
      }),
      host.agent as never,
      shot,
      '看这张图',
      { timeoutMs: 5_000 },
    ),
    /does not accept image input/,
  );
  assert.equal(host.messages.length, 0, 'no turn was started');
  assert.equal(saves, 0);
});

test('nativeVisionTurn: no attachments service fails closed (falls back to ModLens upstream)', async () => {
  const host = fakeHost('x');
  const shot = path.join(workspace().tmpDir, 'shot-no-service.jpg');
  fs.writeFileSync(shot, 'JPEG');
  await assert.rejects(
    nativeVisionTurn(hostDeps({}), host.agent as never, shot, '看', { timeoutMs: 5_000 }),
    /attachments service unavailable/,
  );
  assert.equal(host.messages.length, 0);
});

test('nativeVisionTurn: a hang is a timeout and the orphan turn is cancelled; a cancelled beat cancels too', async () => {
  const host = fakeHost('迟到的回答', 'hang');
  const shot = path.join(workspace().tmpDir, 'shot-hang.jpg');
  fs.writeFileSync(shot, 'JPEG');
  const deps = hostDeps({
    attachments: { saveImage: async () => imageRef },
    llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
  });
  // issue #11: the cancel MUST name an AgentCancelCause — a bare cancel()
  // persists turn/end.reason = null, which makes the whole session unopenable.
  const causes: { kind?: string; reason?: string }[] = [];
  (host.agent as { cancel?: (cause?: { kind?: string; reason?: string }) => void }).cancel = (cause) => {
    causes.push(cause ?? {});
  };
  await assert.rejects(
    nativeVisionTurn(deps, host.agent as never, shot, '看', { timeoutMs: 30 }),
    (e: unknown) => e instanceof BeatAbortedError && (e as BeatAbortedError).stage === 'vision',
  );
  assert.deepEqual(causes[0], { kind: 'hook', reason: 'heartbeat-vision-timeout' });
  // an outside cancellation (beat watchdog) hands control to onAbort
  const ctl = new AbortController();
  const p = nativeVisionTurn(deps, host.agent as never, shot, '看', { timeoutMs: 60_000, signal: ctl.signal });
  ctl.abort('beat watchdog');
  await assert.rejects(p, (e: unknown) => e instanceof BeatAbortedError);
  assert.deepEqual(causes[1], { kind: 'hook', reason: 'heartbeat-vision-aborted' });
  assert.equal(causes.length, 2, 'one cancel per cancelled turn, both named');
});

test('nativeVisionTurn: a turn with no assistant text returns empty (the caller reports a failure)', async () => {
  const host = fakeHost(null);
  const shot = path.join(workspace().tmpDir, 'shot-silent.jpg');
  fs.writeFileSync(shot, 'JPEG');
  const turn = await nativeVisionTurn(
    hostDeps({ attachments: { saveImage: async () => imageRef }, llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) } }),
    host.agent as never,
    shot,
    '看',
    { timeoutMs: 5_000 },
  );
  assert.equal(turn, '');
});
test('native: an error naming a file under data/tmp is scrubbed of the directory', async () => {
  writeCurrentShot();
  const tmpShot = path.join(workspace().tmpDir, 'screen.view.1700000000000.jpg');
  const native = fakeTurn(async () => { throw new Error(`open failed: ${tmpShot}`); });
  const vision = await describeScreenVision(guard, workspace(), {
    moduleUrl: import.meta.url,
    engine: 'native',
    turn: native.turn,
  });
  assert.equal(vision.ok, false);
  assert.ok(!vision.error!.includes(workspace().tmpDir), 'the tmp directory never reaches the audit text');
  assert.ok(vision.error!.includes('<data-tmp>'));
});
// ── the configurable default (settings option) ──────────────────────────
// v2.2.1-native.1 exposes the engine as a plugin config field so "which engine
// is the default" is a setting, not a code edit: config → vision.json →
// built-in auto. The built-in default stays auto (native first).

test('visionEngine: the settings option beats vision.json, an empty value follows it', () => {
  assert.equal(resolveVisionEnginePrecedence('modlens', { engine: 'native' }), 'modlens');
  assert.equal(resolveVisionEnginePrecedence('native', {}), 'native');
  assert.equal(resolveVisionEnginePrecedence('auto', { engine: 'modlens' }), 'auto');
  assert.equal(resolveVisionEnginePrecedence('', { engine: 'native' }), 'native');
  assert.equal(resolveVisionEnginePrecedence(undefined, {}), 'auto');
  // a typo in the settings card never overrides a deliberate vision.json
  assert.equal(resolveVisionEnginePrecedence('bogus', { engine: 'modlens' }), 'modlens');
  assert.equal(resolveVisionEnginePrecedence(42, {}), 'auto');
});

test('visionEngine: the plugin config exposes the field with an empty default', () => {
  const normalize = Config as unknown as (value: unknown) => Record<string, unknown>;
  assert.equal(normalize({}).visionEngine, '');
  assert.equal(normalize({ visionEngine: 'native' }).visionEngine, 'native');
});

test('engine: configuredEngine=modlens takes effect without editing vision.json', async () => {
  writeCurrentShot();
  const native = fakeTurn(async () => '不该被调用');
  const cli = fakeCli({ summary: '(modlens) 在写文档' });
  const vision = await describeScreenVision(guard, workspace(), {
    moduleUrl: import.meta.url,
    configuredEngine: 'modlens',
    turn: native.turn,
    mainPath: cli.mainPath,
    spawnCli: cli.spawnCli,
  });
  assert.equal(vision.ok, true);
  assert.equal(vision.engine, 'modlens');
  assert.equal(native.calls.length, 0, 'the setting can keep the old ModLens behaviour');
});
