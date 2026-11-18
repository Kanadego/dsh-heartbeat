// Native vision engine tests (v2.2.1-native.1): engine resolution, the
// native → ModLens fallback contract, truncation bounds, the privacy rule
// (failure keeps the picture AND the titles away from the caller), and the
// "use then burn" discipline on every path. No ModLens install, no network,
// no real agent: the host turn and the CLI spawn are both fakes.

import { cleanupSandboxes, sandboxDir } from './_sandbox.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import { encryptFile, resetVaultKeyCacheForTest, saveJson } from '../src/vault/vault.js';
import { BeatAbortedError, nativeVisionTurn, type OrchestratorDeps } from '../src/core/orchestrator.js';
import { screenJpgPath, screenJsonPath, screenStampPath } from '../src/screen/screenpulse.js';
import {
  DEFAULT_VISION_ENGINE,
  NATIVE_VISION_PROMPT,
  VISION_PATH_TAIL_SOURCE,
  describeScreenVision,
  readVisionSettings,
  resolveVisionEngine,
  resolveVisionEnginePrecedence,
  scrubShotPath,
  type NativeVisionTurn,
} from '../src/screen/vision.js';
import { auditInvalidVisionEngines, Config, resolveVisionEngineSetting } from '../src/index.js';
import { appendAuditLine, readAuditLines } from '../src/core/audit-log.js';

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;
// Every sandbox THIS file created, kept so the file-level `after` can delete
// them all (H6) instead of only the last one. Both prefixes this file makes are
// tracked: `hb-vision-native-*` here in beforeEach and `hb-vision-data-*`
// (a3 低1) where that case creates it. The cleanup is judged ONLY against this
// list — a same-prefix sandbox from a concurrent run of this file must not red
// a green run, and it cannot: only our own directories are asserted.
const createdSandboxes: string[] = [];

beforeEach(() => {
  sandbox = sandboxDir('hb-vision-native-');
  createdSandboxes.push(sandbox);
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  resetVaultKeyCacheForTest();
  guard = createPathGuard(workspace().dataDir);
});

after(() => {
  resetWorkspaceForTest();
  // H6: beforeEach builds one sandbox per case (~75 per run); deleting only the
  // last one left the rest to the process-exit hook — after a hard kill they
  // pile up in %TEMP%. Delete every sandbox this file made, then prove it.
  cleanupSandboxes();
  const leaked = createdSandboxes.filter((dir) => fs.existsSync(dir));
  assert.equal(leaked.length, 0, 'after must remove every sandbox it created, still there: ' + leaked.join(', '));
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
  // N4: the native failure reason rides along so the audit line can tell a
  // native-only problem from a ModLens one.
  assert.match(vision.nativeError!, /NO_ADAPTER/);
});

test('auto: an EMPTY native answer (no throw) still falls back to ModLens (N8)', async () => {
  // agentTurn-style hosts resolve a dead turn to '' instead of throwing; the
  // router must treat that exactly like a thrown failure.
  writeCurrentShot();
  const native = fakeTurn(async () => '   ');
  const cli = fakeCli({ summary: '(modlens) 在写代码' });
  const vision = await describeScreenVision(guard, workspace(), {
    moduleUrl: import.meta.url,
    turn: native.turn,
    mainPath: cli.mainPath,
    spawnCli: cli.spawnCli,
  });
  assert.equal(vision.ok, true);
  assert.equal(vision.summary, '(modlens) 在写代码');
  assert.equal(vision.engine, 'modlens');
  assert.equal(native.calls.length, 1, 'native was tried first');
  assert.equal(cli.calls.length, 1, 'the empty answer fell back to ModLens');
  assert.match(vision.nativeError!, /no summary/);
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

test('nativeVisionTurn: a host without the llm service skips the probe and still delivers the image (N8)', async () => {
  // The modality probe is a capability check, not a hard dependency: a host
  // that exposes no `llm` service must take the degrade path (send the image
  // unprobed), not throw.
  const host = fakeHost('在 IDE 里写测试');
  const shot = path.join(workspace().tmpDir, 'shot-no-llm.jpg');
  fs.writeFileSync(shot, 'JPEG');
  const turn = await nativeVisionTurn(
    hostDeps({ attachments: { saveImage: async () => imageRef } }),
    host.agent as never,
    shot,
    '看这张图',
    { timeoutMs: 5_000 },
  );
  assert.equal(turn, '在 IDE 里写测试');
  assert.equal(host.messages.length, 1, 'the turn ran without the probe');
  const parts = host.messages[0]!.content as { type: string }[];
  assert.equal(parts[1]!.type, 'image');
});

test('nativeVisionTurn: a throwing modality probe is audited and fails the native read (N6)', async () => {
  // Registry jitter used to escape untyped and unaudited; it must surface in
  // the audit log and still refuse the image (the fallback stays talk-only).
  const host = fakeHost('编出来的画面');
  const shot = path.join(workspace().tmpDir, 'shot-probe-boom.jpg');
  fs.writeFileSync(shot, 'JPEG');
  let saves = 0;
  // N18: record the probe's arguments — the third one must BE the beat's
  // signal (same object), or the beat's cancellation cannot reach the probe.
  let probeArgs: unknown[] | undefined;
  const ctl = new AbortController();
  await assert.rejects(
    nativeVisionTurn(
      hostDeps({
        attachments: { saveImage: async () => { saves += 1; return imageRef; } },
        llm: { resolveModelInfo: async (...args: unknown[]) => { probeArgs = args; throw new Error('registry not ready'); } },
      }),
      host.agent as never,
      shot,
      '看这张图',
      { timeoutMs: 5_000, signal: ctl.signal },
    ),
    /modality probe failed/,
  );
  assert.equal(host.messages.length, 0, 'no turn was started');
  assert.equal(saves, 0, 'no image was stored');
  assert.equal(probeArgs?.[0], 'deepseek', 'the probe gets the provider');
  assert.equal(probeArgs?.[1], 'deepseek-flash', 'the probe gets the model');
  assert.equal(probeArgs?.[2], ctl.signal, 'the probe gets the beat signal as the same object (N6)');
  const auditFile = path.join(workspace().logsDir, 'heartbeat.jsonl');
  const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as { event?: string; model?: string; error?: string });
  const probed = lines.find((l) => l.event === 'vision_modality_probe_failed');
  assert.ok(probed, 'the probe failure is audited');
  assert.equal(probed.model, 'deepseek-flash');
  assert.match(probed.error!, /registry not ready/);
});

test('nativeVisionTurn: an already-cancelled beat never starts the turn (N5)', async () => {
  const host = fakeHost('迟到的回答');
  const shot = path.join(workspace().tmpDir, 'shot-cancelled.jpg');
  fs.writeFileSync(shot, 'JPEG');
  const ctl = new AbortController();
  ctl.abort('beat watchdog');
  await assert.rejects(
    nativeVisionTurn(
      hostDeps({ attachments: { saveImage: async () => imageRef } }),
      host.agent as never,
      shot,
      '看',
      { timeoutMs: 5_000, signal: ctl.signal },
    ),
    (e: unknown) => e instanceof BeatAbortedError,
  );
  assert.equal(host.messages.length, 0, 'the entry guard stopped the round before followup');
});

// ── N18: a cancellation is not a vision failure ──────────────────────────
// Dispose landing exactly at the vision entry used to be swallowed into
// ok:false, which made `auto` spawn ModLens on a dead signal and write a
// misleading ok:false audit; an abort during the modality probe was labelled
// a probe failure. The abort must propagate untouched.

test('auto: an abort at the vision entry propagates — no ModLens spawn, no ok:false (N18)', async () => {
  writeCurrentShot();
  // Production chain: the turn IS nativeVisionTurn, whose entry throwIfAborted
  // throws BeatAbortedError; the fake reproduces exactly that.
  const native = fakeTurn(async () => { throw new BeatAbortedError('vision', 'orchestrator disposed'); });
  const cli = fakeCli({ summary: '不该被拉起' });
  const ctl = new AbortController();
  ctl.abort('orchestrator disposed');
  await assert.rejects(
    describeScreenVision(guard, workspace(), {
      moduleUrl: import.meta.url,
      turn: native.turn,
      mainPath: cli.mainPath,
      spawnCli: cli.spawnCli,
      signal: ctl.signal,
    }),
    (e: unknown) => e instanceof BeatAbortedError && (e as BeatAbortedError).why === 'orchestrator disposed',
  );
  assert.equal(cli.calls.length, 0, 'the aborted beat never spawns ModLens');
  assert.deepEqual(leftoverPlaintext(), [], 'the unlocked shot is still burned on the abort path');
});

test('auto: a beat aborted mid-read short-circuits instead of spawning ModLens (N18)', async () => {
  writeCurrentShot();
  const native = fakeTurn(async () => '   '); // read "completes" empty while the abort lands
  const cli = fakeCli({ summary: '不该被拉起' });
  const ctl = new AbortController();
  const p = describeScreenVision(guard, workspace(), {
    moduleUrl: import.meta.url,
    turn: native.turn,
    mainPath: cli.mainPath,
    spawnCli: cli.spawnCli,
    signal: ctl.signal,
  });
  ctl.abort('beat watchdog');
  await assert.rejects(p, /vision aborted before ModLens fallback/);
  assert.equal(cli.calls.length, 0, 'no fallback run on a dead signal');
});

test('nativeVisionTurn: an abort during the modality probe is not a probe failure (N18)', async () => {
  const host = fakeHost('不该有画面');
  const shot = path.join(workspace().tmpDir, 'shot-probe-abort.jpg');
  fs.writeFileSync(shot, 'JPEG');
  const ctl = new AbortController();
  const p = nativeVisionTurn(
    hostDeps({
      attachments: { saveImage: async () => imageRef },
      llm: {
        resolveModelInfo: (_provider: string, _model: string, signal?: AbortSignal) => new Promise<never>((_, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('probe aborted mid-flight')), { once: true });
        }),
      },
    }),
    host.agent as never,
    shot,
    '看这张图',
    { timeoutMs: 5_000, signal: ctl.signal },
  );
  setTimeout(() => ctl.abort('beat watchdog'), 50); // abort lands WHILE the probe is in flight
  await assert.rejects(
    p,
    /probe aborted mid-flight/, // rethrown untouched — NOT wrapped as "probe failed"
  );
  assert.equal(host.messages.length, 0, 'no turn was started');
  const auditFile = path.join(workspace().logsDir, 'heartbeat.jsonl');
  const lines = fs.existsSync(auditFile)
    ? fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as { event?: string })
    : [];
  assert.equal(
    lines.find((l) => l.event === 'vision_modality_probe_failed'),
    undefined,
    'a cancellation must not be audited as a probe failure',
  );
});

// ── N18 rework 中2: the other two abort paths ─────────────────────────────
// describeScreenShot's catch used to swallow an abort into ok:false (the CLI
// path is where a signal-killed subprocess surfaces), and the router's abort
// check sat AFTER the engine==='native' return — so an aborted native-only
// read still produced a result the caller audited as a vision failure.
//
// Coverage note (reviewer-approved): a modlens-engine BEAT-level abort case is
// not constructible in this environment — @liustack/modlens is not installed,
// so resolveModlensMain returns null and describeScreenShot early-returns fully
// synchronously (no await window for an abort to land in, and a beat's
// controller cannot be aborted by a fake that only holds the AbortSignal).
// The modlens path is therefore pinned HERE at unit level (①a: the catch
// rethrow; ①b: the abort check before the engine==='native' return), and the
// beat-level booking is pinned by the disposer-driven case in
// session-gate-beat.test.ts (②).

test('modlens: a CLI run rejected on an aborted signal propagates — not ok:false (N18 rework 中2)', async () => {
  writeCurrentShot();
  const cli = fakeCli({ summary: '不该出现' });
  const ctl = new AbortController();
  let spawnAttempts = 0;
  // a3: the viaModlens entry check intercepts an ALREADY-dead signal before
  // spawnCli, so the abort here lands DURING the CLI run — the rejection still
  // has to ride the describeScreenShot catch rethrow (never ok:false).
  const p = describeScreenVision(guard, workspace(), {
    moduleUrl: import.meta.url,
    engine: 'modlens',
    mainPath: cli.mainPath,
    spawnCli: async (_cmd: string, args: string[], _timeoutMs: number, signal?: AbortSignal) => {
      spawnAttempts += 1;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('cli killed by abort')), { once: true });
      });
    },
    signal: ctl.signal,
  });
  ctl.abort('beat watchdog');
  await assert.rejects(
    p,
    /cli killed by abort/,
    'the abort must rethrow out of describeScreenShot, not become ok:false',
  );
  assert.equal(spawnAttempts, 1, 'the (killed) spawn was attempted, then rejected');
});

test('native: an aborted beat never returns ok:false — the abort wins over the engine result (N18 rework 中2)', async () => {
  // The read "fails normally" AFTER the abort has already landed: a fake turn
  // returning an empty answer yields ok:false 'native vision produced no
  // summary'. The router's abort check must fire BEFORE the engine==='native'
  // return, or the caller books a screen_vision ok:false for a cancellation.
  // A6 低5 added a NATIVE ENTRY guard, so the abort must land MID-READ here —
  // an already-dead signal now stops before the turn, which is a different pin.
  writeCurrentShot();
  const ctl = new AbortController();
  const native = fakeTurn(async () => {
    ctl.abort('beat watchdog'); // lands while the native read is in flight
    return '   ';
  });
  const cli = unusedCli();
  await assert.rejects(
    describeScreenVision(guard, workspace(), {
      moduleUrl: import.meta.url,
      engine: 'native',
      turn: native.turn,
      mainPath: cli.mainPath,
      spawnCli: cli.spawnCli,
      signal: ctl.signal,
    }),
    /vision aborted \(native vision produced no summary\)/,
  );
  assert.equal(native.calls.length, 1, 'the read ran, then the abort decided the booking');
  assert.equal(cli.calls.length, 0, 'no ModLens spawn either way');
});

// ── N18-a3 中1: engine='modlens' takes the DIRECT viaModlens() return, which
//    never saw the router's abort checks — a dead signal used to produce plain
//    ok:false results (no screenshot / modlens not installed / exit nonzero /
//    no summary) that the caller booked as screen_vision ok:false.

test('modlens: an aborted beat never even starts a ModLens run (N18-a3 中1)', async () => {
  writeCurrentShot();
  const cli = fakeCli({ summary: '不该被拉起' });
  const ctl = new AbortController();
  ctl.abort('beat watchdog');
  await assert.rejects(
    describeScreenVision(guard, workspace(), {
      moduleUrl: import.meta.url,
      engine: 'modlens',
      mainPath: cli.mainPath,
      spawnCli: cli.spawnCli,
      signal: ctl.signal,
    }),
    (e: unknown) => e instanceof BeatAbortedError
      && (e as BeatAbortedError).stage === 'vision'
      && /signal already dead before ModLens run/.test((e as BeatAbortedError).why),
    'the viaModlens entry check must short-circuit before any ModLens work',
  );
  assert.equal(cli.calls.length, 0, 'no CLI run on a dead signal');
});

test('modlens: no screenshot on an aborted signal propagates — not ok:false (N18-a3 中1)', async () => {
  // No writeCurrentShot(): the beat has no screenshot and the signal is already
  // dead. The rejection here comes from the viaModlens entry check (the
  // no-shot path is fully synchronous behind it — no abort window), which is
  // exactly what reviewer case (a) demands: the direct branch THROWS instead
  // of returning ok:false.
  const cli = fakeCli({ summary: '不该出现' });
  const ctl = new AbortController();
  ctl.abort('beat watchdog');
  await assert.rejects(
    describeScreenVision(guard, workspace(), {
      moduleUrl: import.meta.url,
      engine: 'modlens',
      mainPath: cli.mainPath,
      spawnCli: cli.spawnCli,
      signal: ctl.signal,
    }),
    (e: unknown) => e instanceof BeatAbortedError
      && (e as BeatAbortedError).stage === 'vision'
      && /signal already dead before ModLens run/.test((e as BeatAbortedError).why),
    'A6 低3: the entry abort carries the beat class + stage, not a plain Error',
  );
  assert.equal(cli.calls.length, 0, 'no CLI run on a dead signal');
});

test('modlens: a CLI exiting nonzero on an aborted signal propagates — not ok:false (N18-a3 中1)', async () => {
  writeCurrentShot();
  const ctl = new AbortController();
  let spawnAttempts = 0;
  // The CLI "exits nonzero" exactly when the abort lands — the failure return
  // is a normal return (the catch never fires), so only the abort-aware
  // failure path can turn it into a cancellation.
  const p = describeScreenVision(guard, workspace(), {
    moduleUrl: import.meta.url,
    engine: 'modlens',
    mainPath: path.join(workspace().tmpDir, 'fake-modlens-main.js'),
    spawnCli: async (_cmd: string, _args: string[], _timeoutMs: number, signal?: AbortSignal) => {
      spawnAttempts += 1;
      return new Promise((resolve) => {
        signal?.addEventListener('abort', () => resolve({ code: 1, stderr: 'killed' }), { once: true });
      });
    },
    signal: ctl.signal,
  });
  ctl.abort('beat watchdog');
  await assert.rejects(
    p,
    (e: unknown) => e instanceof BeatAbortedError
      && (e as BeatAbortedError).stage === 'vision'
      && /modlens exit 1/.test((e as BeatAbortedError).why),
    'the exit-nonzero failure must ride the abort (A6 低3: as the beat class)',
  );
  assert.equal(spawnAttempts, 1, 'the CLI run was attempted, then the abort decided the booking');
});

// ── N18-a3 中3: the production writer (appendAuditLine) never THROWS — it
//    reports a failed append as `false`. The throw-based 低1 test cannot see
//    that path: with a bad log path the key used to be consumed anyway and the
//    typo was silenced for the whole process lifetime.

test('auditInvalidVisionEngines: a production appendAuditLine failure does not consume the key (N18-a3 中3)', () => {
  // Make the log path's PARENT a file, so mkdir/append genuinely fails and
  // appendAuditLine returns false — no fake writer, the real production one.
  const badParent = path.join(workspace().tmpDir, 'badlog-parent');
  fs.writeFileSync(badParent, 'a file, not a directory');
  const badLog = path.join(badParent, 'heartbeat.jsonl');
  const goodLog = path.join(workspace().logsDir, 'heartbeat.jsonl');
  const seen = new Set<string>();
  const invalid = [{ source: 'config' as const, value: 'bogus' }];
  auditInvalidVisionEngines(invalid, seen, (e) => appendAuditLine(badLog, e)); // append fails → false
  assert.equal(seen.size, 0, 'the failed append must NOT consume the key');
  auditInvalidVisionEngines(invalid, seen, (e) => appendAuditLine(goodLog, e)); // next beat: retry lands
  assert.equal(seen.size, 1, 'the typo was not silenced by the earlier failed append');
  assert.ok(
    readAuditLines<{ event?: string }>(goodLog).some((l) => l.event === 'vision_engine_invalid'),
    'the retried entry really landed in the working log',
  );
});

// ── N18-a3 低5: the modality probe is a real await window — an abort landing
//    there must stop BEFORE the screenshot is written into the home's durable
//    attachment store.

test('nativeVisionTurn: an abort during the probe stops before the image is stored (N18-a3 低5)', async () => {
  const host = fakeHost('不该有画面');
  const shot = path.join(workspace().tmpDir, 'shot-pre-save-abort.jpg');
  fs.writeFileSync(shot, 'JPEG');
  let saves = 0;
  const ctl = new AbortController();
  const p = nativeVisionTurn(
    hostDeps({
      attachments: { saveImage: async () => { saves += 1; return imageRef; } },
      llm: {
        resolveModelInfo: (_provider: string, _model: string, signal?: AbortSignal) => new Promise((resolve) => {
          signal?.addEventListener('abort', () => resolve({ inputModalities: ['text', 'image'] }), { once: true });
        }),
      },
    }),
    host.agent as never,
    shot,
    '看这张图',
    { timeoutMs: 5_000, signal: ctl.signal },
  );
  ctl.abort('beat watchdog'); // lands while the probe is in flight
  await assert.rejects(p, (e: unknown) => e instanceof BeatAbortedError);
  assert.equal(saves, 0, 'the screenshot must not be stored into the attachment store');
});

test('nativeVisionTurn: an abort landing in the saveImage window leaves no orphan turn or message (A6 低2)', async () => {
  // saveImage is its own await window: the host persists the picture and only
  // then hands back the ref. The abort lands INSIDE that call. Without a second
  // throwIfAborted right after it, the beat still rejected as cancelled but had
  // already handed the message to agent.followup — the session ended up with a
  // cancelled heartbeat user message referencing the fresh attachment.
  const host = fakeHost('迟到的回答');
  const shot = path.join(workspace().tmpDir, 'shot-save-abort.jpg');
  fs.writeFileSync(shot, 'JPEG');
  const ctl = new AbortController();
  let saves = 0;
  const p = nativeVisionTurn(
    hostDeps({
      attachments: {
        saveImage: async () => {
          saves += 1;
          ctl.abort('beat watchdog'); // the abort lands in the saveImage window
          return imageRef;
        },
      },
      llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
    }),
    host.agent as never,
    shot,
    '看这张图',
    { timeoutMs: 5_000, signal: ctl.signal },
  );
  await assert.rejects(
    p,
    (e: unknown) => e instanceof BeatAbortedError && (e as BeatAbortedError).stage === 'vision',
  );
  assert.equal(saves, 1, 'the host store call already happened — its durable copy cannot be revoked');
  assert.equal(host.messages.length, 0, 'no followup: the picture never becomes a cancelled heartbeat message');
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
  // an outside cancellation (beat watchdog) hands control to onAbort.
  // N18-a3 低5 note: the abort must land AFTER the turn started — since the
  // pre-save guard, an abort during the PROBE stops before the image is stored
  // and no host turn exists to cancel (covered by the 低5 test below). Wrap
  // followup so the abort lands exactly inside the whenIdle wait.
  const ctl = new AbortController();
  const turnStarted = new Promise<void>((resolve) => {
    const inner = (host.agent as { followup: (...a: unknown[]) => void }).followup;
    (host.agent as { followup: unknown }).followup = (...a: unknown[]) => {
      resolve();
      return inner(...a);
    };
  });
  const p = nativeVisionTurn(deps, host.agent as never, shot, '看', { timeoutMs: 60_000, signal: ctl.signal });
  await turnStarted; // the turn is parked in its whenIdle wait
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
// ── a4 cross-review ④⑤: the ABORT rethrow must scrub too, and a modlens
//    success on a dead signal is a cancellation, not ok:true ──────────────

test('native: an abort rethrow is scrubbed of the tmp shot path too (a4 ④)', async () => {
  // The ok:false path above was already scrubbed; the abort rethrow bypassed
  // it and rode the beat boundary's beat_aborted error field into the audit
  // with whatever text the turn died with — including the plaintext shot path.
  writeCurrentShot();
  const ctl = new AbortController();
  const p = describeScreenVision(guard, workspace(), {
    moduleUrl: import.meta.url,
    engine: 'native',
    signal: ctl.signal,
    turn: async (shotPath: string) => {
      ctl.abort('beat watchdog'); // the abort lands mid-turn
      throw new Error(`read failed for ${shotPath}`); // the path rides the error
    },
  });
  await assert.rejects(p, (e: unknown) => {
    const text = String(e);
    assert.match(text, /read failed for <screenshot>/, 'the shot path is replaced by the placeholder');
    assert.ok(!text.includes('screen.view.'), 'no plaintext tmp shot name anywhere in the abort text');
    assert.ok(!text.includes(workspace().tmpDir), 'no raw tmp dir path in the abort text');
    assert.ok(!text.includes('Error: Error:'), 'A6 低4③: the wrapper never doubles the Error: prefix');
    return true;
  });
});

test('modlens: a success on a dead signal is a cancellation — not ok:true (a4 ⑤)', async () => {
  // The CLI run completes with a summary exactly when the abort lands: the
  // success return used to fall through (ok:true) while the beat was already
  // unwinding — the native engine discards such a result at its abort check,
  // so the direct modlens branch must throw the same way.
  writeCurrentShot();
  const cli = fakeCli({ summary: '迟到的成功' });
  const ctl = new AbortController();
  const spawnCli = async (_cmd: string, args: string[], _timeoutMs: number, signal?: AbortSignal) => {
    cli.calls.push(args);
    const out = args[args.indexOf('-o') + 1]!;
    fs.writeFileSync(out, JSON.stringify({ result: { summary: '迟到的成功' } }));
    return new Promise<{ code: number }>((resolve) => {
      signal?.addEventListener('abort', () => resolve({ code: 0 }), { once: true });
    });
  };
  const p = describeScreenVision(guard, workspace(), {
    moduleUrl: import.meta.url,
    engine: 'modlens',
    mainPath: cli.mainPath,
    spawnCli,
    signal: ctl.signal,
  });
  ctl.abort('beat watchdog'); // lands while the CLI is in flight; it still "succeeds"
  await assert.rejects(
    p,
    (e: unknown) => e instanceof BeatAbortedError
      && (e as BeatAbortedError).stage === 'vision'
      && /beat cancelled mid-read/.test((e as BeatAbortedError).why),
    'a success on a dead signal must ride the abort, not return ok:true',
  );
  assert.equal(cli.calls.length, 1, 'the CLI really ran — only the success booking changes');
});

// ── A6 (cross-review 0b2c1d76): the modlens-side scrub had no pin of its own,
//    the scrub could be bypassed three ways, and the two remaining abort
//    branches (native entry / native success on a dead signal) were unpinned.
//    Each case below names the exact mutation it is built to red on.

/** Stub ModLens entry that exists on disk; the spawn fake decides the fate. */
function modlensStubMain(): string {
  const mainPath = path.join(workspace().tmpDir, 'fake-modlens-a6-main.js');
  fs.writeFileSync(mainPath, '// stub');
  return mainPath;
}

test('modlens: a CLI crash whose stderr quotes the shot path is scrubbed out of ok:false (A6 中2 ① / 低4②)', async () => {
  // Pins describeScreenShot's catch-return scrub (vision.ts: the
  // `error: scrubShotPath(...)` inside `catch`). A crash rejection whose text
  // carries the CLI's stderr — stderr naming the plaintext shot — must not put
  // the path (or its basename) into the ok:false error field.
  writeCurrentShot();
  const mainPath = modlensStubMain();
  let shotArg = '';
  const vision = await describeScreenVision(guard, workspace(), {
    moduleUrl: import.meta.url,
    engine: 'modlens',
    mainPath,
    spawnCli: async (_cmd: string, args: string[]) => {
      shotArg = args[args.indexOf('-i') + 1]!;
      const stderr = `cannot open ${shotArg}`; // the CLI's own stderr line
      throw new Error(`modlens crashed (exit 2): ${stderr}`);
    },
  });
  assert.equal(vision.ok, false);
  assert.ok(shotArg.includes('screen.view.'), 'precondition: the CLI was handed the plaintext shot');
  assert.ok(vision.error!.includes('<screenshot>'), 'the shot path is replaced by the placeholder');
  assert.ok(!vision.error!.includes(shotArg), 'the raw shot path never reaches the audit text');
  assert.ok(!vision.error!.includes(path.basename(shotArg)), 'nor its bare file name');
  assert.ok(!vision.error!.includes(workspace().tmpDir), 'nor the tmp directory');
  assert.deepEqual(leftoverPlaintext(), [], 'the plaintext is burned on the failure path too');
});

test('modlens: a spawn rejection quoting the shot path on a dead signal rethrows scrubbed as the beat class (A6 中2 ② / 低3)', async () => {
  // Pins the catch's ABORT rethrow (vision.ts: the scrubbed `throw` when
  // opts.signal is dead) and 低3's class: the rejection must be a real
  // BeatAbortedError (stage 'vision'), scrubbed, not a plain Error carrying the
  // tmp path into the beat_aborted error field.
  writeCurrentShot();
  const mainPath = modlensStubMain();
  const ctl = new AbortController();
  let shotArg = '';
  const p = describeScreenVision(guard, workspace(), {
    moduleUrl: import.meta.url,
    engine: 'modlens',
    mainPath,
    signal: ctl.signal,
    spawnCli: (_cmd: string, args: string[], _timeoutMs: number, signal?: AbortSignal) => {
      shotArg = args[args.indexOf('-i') + 1]!;
      return new Promise<{ code: number }>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error(`cli killed: cannot read ${shotArg}`)), { once: true });
      });
    },
  });
  ctl.abort('beat watchdog');
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof BeatAbortedError, 'the abort must keep the beat class');
    assert.equal((e as BeatAbortedError).stage, 'vision', 'the boundary books stage "vision", not "unknown"');
    const text = String(e);
    assert.ok(text.includes('<screenshot>'), 'the shot path is replaced by the placeholder');
    assert.ok(!text.includes(shotArg), 'the raw shot path never rides the abort text');
    assert.ok(!text.includes(workspace().tmpDir), 'nor the tmp directory');
    // 低4③: the reason must not carry the `Error: ` toString prefix (the class
    // name itself legitimately ends in "…Error:", so check the why field).
    assert.ok(
      !/^Error: /.test((e as BeatAbortedError).why),
      'A6 低4③: the why text carries no Error: toString prefix',
    );
    return true;
  });
});

test('native: a probe rethrow that quotes the shot path is scrubbed to the placeholder (A6 低4, reviewer follow-up)', async () => {
  // The native probe's scrub rethrow gets its own pin, independent of the ②
  // beat case: the plain Error carries the tmp shot path while the signal dies,
  // so the rethrow must scrub it and must not double the `Error: ` prefix.
  writeCurrentShot();
  const ctl = new AbortController();
  let shot = '';
  const p = describeScreenVision(guard, workspace(), {
    moduleUrl: import.meta.url,
    engine: 'native',
    signal: ctl.signal,
    turn: async (shotPath: string) => {
      shot = shotPath;
      ctl.abort('beat watchdog'); // the abort lands mid-read
      throw new Error(`probe exploded for ${shotPath}`); // the path rides the error
    },
  });
  await assert.rejects(p, (e: unknown) => {
    const text = String(e);
    assert.match(text, /probe exploded for <screenshot>/, 'the shot path is replaced by the placeholder');
    assert.ok(!text.includes(shot), 'the raw shot path never rides the abort text');
    assert.ok(!text.includes(workspace().tmpDir), 'nor the tmp directory');
    assert.ok(!text.includes('Error: Error:'), 'A6 低4③: no doubled Error: prefix');
    return true;
  });
});

test('native: a failure quoting the shot path with FORWARD slashes is scrubbed too (A6 低4 ①)', async () => {
  // A CLI or formatter may normalize to '/'; the old split/join only matched the
  // backslash form and left 'C:/Users/.../tmp/<screenshot>' in the audit.
  writeCurrentShot();
  let shot = '';
  const native = fakeTurn(async (shotPath) => {
    shot = shotPath;
    throw new Error(`open failed: ${shotPath.replace(/\\/g, '/')}`);
  });
  const vision = await describeScreenVision(guard, workspace(), {
    moduleUrl: import.meta.url,
    engine: 'native',
    turn: native.turn,
  });
  assert.equal(vision.ok, false);
  assert.ok(shot, 'precondition: the turn saw the plaintext shot');
  assert.ok(vision.error!.includes('<screenshot>'), 'the forward-slash path is replaced too');
  assert.ok(!vision.error!.includes(shot.replace(/\\/g, '/')), 'no forward-slash copy of the path');
  assert.ok(!/C:[\\/]/i.test(vision.error!), 'no drive-letter path survives in either separator style');
});

test('modlens: a path starting near the old 140-char stderr cut is still scrubbed (A6 低4 ②)', async () => {
  // The old code sliced stderr to 140 chars BEFORE scrubbing: a path straddling
  // the cut left an unmatchable fragment ('C:\\Users\\\u2026') in the audit.
  writeCurrentShot();
  const mainPath = modlensStubMain();
  const filler = 'E'.repeat(130); // pushes the path past the old 140-char cut
  const vision = await describeScreenVision(guard, workspace(), {
    moduleUrl: import.meta.url,
    engine: 'modlens',
    mainPath,
    spawnCli: async (_cmd: string, args: string[]) => {
      const shot = args[args.indexOf('-i') + 1]!;
      return { code: 2, stderr: `${filler} ${shot} tail` };
    },
  });
  assert.equal(vision.ok, false);
  assert.ok(vision.error!.includes('<screenshot>'), 'the path is replaced, not cut in half');
  assert.ok(!vision.error!.includes('screen.view'), 'no plaintext shot name survives the cut');
  assert.ok(!/C:[\\/]/i.test(vision.error!), 'no drive-letter fragment survives the cut');
});

// ── N25①: the scrub must survive separator mixes, a lowercased drive, spaces
//    inside a path, an upstream truncation and non-Windows roots. The
//    component-wise [\\/]+ match pins the shot path; the root-aware pass pins
//    this machine's home/tmp/data roots (spaces included); the shape fallback
//    pins foreign/truncated drive, UNC and POSIX paths.

/** Throw a native turn error carrying `text`; return the scrubbed ok:false. */
async function nativeScrub(text: (shotPath: string) => string): Promise<{ shot: string; error: string }> {
  writeCurrentShot();
  let shot = '';
  const native = fakeTurn(async (shotPath) => {
    shot = shotPath;
    throw new Error(text(shotPath));
  });
  const vision = await describeScreenVision(guard, workspace(), {
    moduleUrl: import.meta.url,
    engine: 'native',
    turn: native.turn,
  });
  assert.equal(vision.ok, false);
  assert.ok(shot, 'precondition: the turn saw the plaintext shot');
  return { shot, error: vision.error! };
}

test('scrub N25①: a mixed-separator shot path is replaced whole (no home prefix)', async () => {
  // The old literal split/join only matched the two uniform forms; a CLI that
  // mixes '/' and '\\' left 'C:/Users/<name>/.../tmp/<screenshot>' behind.
  const { error } = await nativeScrub((shotPath) => {
    let flip = false;
    const mixed = shotPath.replace(/[\\/]/g, () => (flip = !flip) ? '/' : '\\');
    return `read failed: ${mixed}`;
  });
  assert.match(error, /read failed: <screenshot>$/, 'the shot path is replaced whole despite mixed separators');
  assert.ok(!/users[\\/]/i.test(error), 'no user-directory prefix survives in any separator mix');
  assert.ok(!/[A-Za-z]:[\\/]/.test(error), 'no drive-rooted fragment survives');
});

test('scrub N25①: a lowercased shot path is replaced too (case-insensitive match)', async () => {
  const { error } = await nativeScrub((shotPath) => `read failed: ${shotPath.toLowerCase()}`);
  assert.match(error, /read failed: <screenshot>$/, 'the lowercased shot path is replaced whole');
  assert.ok(!/users/i.test(error), 'no user-directory prefix survives the case fold');
});

test('scrub N25①: an upstream-truncated absolute path is replaced whole (fallback)', async () => {
  // A FOREIGN absolute path (not under this machine's home/tmp/data roots) — so
  // only the shape fallback can catch it; a truncated prefix still names the
  // directory it was cut out of. Not built from os.tmpdir() on purpose: a path
  // under this machine's root is the root pass's job (see the <tmp> 用例 below).
  const truncated = process.platform === 'win32'
    ? 'D:\\probe\\hb-probe-trunc-J'
    : '/var/probe/hb-probe-trunc-J';
  const { error } = await nativeScrub(() => `modlens exit 2: cannot open ${truncated} [truncated by CLI]`);
  assert.ok(error.includes('<path>'), 'the truncated absolute path is replaced by the fallback placeholder');
  assert.ok(!error.includes('hb-probe-trunc-J'), 'no directory prefix of the truncated path survives');
  assert.ok(error.includes('[truncated by CLI]'), 'the upstream note is preserved, not swallowed');
  assert.ok(error.startsWith('modlens exit 2: cannot open '), 'the failure reason is preserved');
});

test('scrub rework 中1: a path under this machine\'s tmp root collapses to <tmp>', async () => {
  // Root-aware pass (rework 中1/中2): the OS temp root is replaced BEFORE the
  // shape fallback, whole path included, so neither the user name nor the
  // nested directories reach the audit.
  const p = path.join(os.tmpdir(), 'hb-probe-week', 'shot.png');
  const { error } = await nativeScrub(() => `modlens exit 2: cannot open ${p}`);
  assert.equal(error, 'modlens exit 2: cannot open <tmp>', 'the whole tmp-rooted path becomes <tmp>');
});

test('scrub rework 中1: a path under this machine\'s home collapses to <home>', async () => {
  // POSIX hosts get the same treatment (the root pass is platform-neutral), so
  // the earlier tmp-only, separators-only assumption no longer holds.
  const p = path.join(os.homedir(), 'secret', 'x.png');
  const { error } = await nativeScrub(() => `cannot open ${p}`);
  assert.equal(error, 'cannot open <home>', 'the whole home-rooted path becomes <home>');
});

test('scrub rework 中1: a foreign absolute path containing spaces is replaced whole', async () => {
  // The old suffix `[^\s…]*` stopped at the first space and left
  // ' Doe\AppData\…\shot.png' in the audit — the same privacy leak, just from a
  // machine whose user name has a space. A space continues the match only when
  // the token behind it still looks like a path segment.
  const foreign = 'C:\\Users\\John Doe\\AppData\\Local\\Temp\\hb-probe\\shot.png';
  const { error } = await nativeScrub(() => `modlens exit 2: cannot open ${foreign} (ENOENT)`);
  assert.ok(error.includes('<path>'), 'the spaced absolute path is replaced by the fallback placeholder');
  assert.ok(!/john|doe/i.test(error), 'no user name survives');
  assert.ok(!error.includes('AppData'), 'no AppData segment survives');
  assert.ok(!error.includes('shot.png'), 'no bare file name survives');
  assert.ok(error.includes('(ENOENT)'), 'the error reason is preserved');
});

test('scrub rework 中2: a POSIX absolute path is replaced whole (cross-platform fallback)', async () => {
  // The reviewer's probe: /home/john/secret/x.png used to pass through on
  // win32 (and a POSIX host must scrub it too); assert platform-neutral.
  const { error } = await nativeScrub(() => 'cannot open /home/john/secret/x.png (ENOENT)');
  assert.match(error, /^cannot open <(path|home)> \(ENOENT\)$/, 'the POSIX path collapses to one placeholder');
  assert.ok(!/john|secret|x\.png/.test(error), 'no POSIX user or file fragment survives');
});

test('scrub N25① 低5: two absolute paths are both replaced; doubled separators too', async () => {
  const two = await nativeScrub(() => 'copy C:\\a\\one.png to D:\\work\\two.png');
  assert.equal(two.error, 'copy <path> to <path>', 'each absolute path gets its own placeholder');
  // JSON-escaped (doubled) separators are the same path, not four segments.
  const doubled = 'C:\\\\Users\\\\John Doe\\\\AppData\\\\x.png';
  const escaped = await nativeScrub(() => `json: "${doubled}"`);
  assert.equal(escaped.error, 'json: "<path>"', 'the doubled-separator path is replaced whole');
});

test('scrub rework a3 中1: a sibling of the home root is not read as <home>', async () => {
  // The root pass needs a right boundary: `…\crash2` and `…\crash-data` share a
  // prefix with home but are different directories — a prefix match used to
  // leave '2\secret\x.png' / '-data\…\screen.view.<ts>.jpg' in the audit.
  const user = path.basename(os.homedir());
  const sibling = process.platform === 'win32'
    ? `${path.dirname(os.homedir())}\\${user}2\\secret\\x.png`
    : `${os.homedir()}2/secret/x.png`;
  const sib = await nativeScrub(() => `open ${sibling}`);
  assert.ok(sib.error.includes('<path>'), 'the sibling path is scrubbed by the shape fallback');
  assert.ok(!sib.error.includes('secret'), 'no sibling directory survives');
  assert.ok(!sib.error.includes('x.png'), 'no file name survives');

  const dashy = path.join(`${os.homedir()}-data`, 'heartbeat', 'tmp', 'screen.view.1700.jpg');
  const dash = await nativeScrub(() => `open ${dashy} [truncated by CLI]`);
  assert.ok(!dash.error.includes('screen.view'), 'the sibling directory\'s shot name never reaches the audit');
  assert.ok(dash.error.includes('[truncated by CLI]'), 'the truncated note is preserved');
});

test('scrub rework a4 中2: prose behind a path survives (ASCII-segment continuation)', async () => {
  // A continuation across a space must be an ASCII file-name segment; prose, a
  // URL, a bracketed hint or a SECOND absolute path starts a new token, so the
  // failure reason is not swallowed into the placeholder.
  const rooted = path.join(os.homedir(), 'a.png');
  const chinese = await nativeScrub(() => `open ${rooted} 读取/写入失败`);
  assert.equal(chinese.error, 'open <home> 读取/写入失败', 'CJK prose ends the path');
  const rootedUrl = await nativeScrub(() => `open ${rooted} https://example.com/api/x`);
  assert.equal(rootedUrl.error, 'open <home> https://example.com/api/x', 'a URL is not a path continuation');
  const rootedParen = await nativeScrub(() => `open ${rooted} (open/read failed)`);
  assert.equal(rootedParen.error, 'open <home> (open/read failed)', 'a bracketed hint is not swallowed');

  const p = 'D:\\probe\\a.png';
  const two = await nativeScrub(() => `copy ${p} E:\\work\\b.png`);
  assert.equal(two.error, 'copy <path> <path>', 'a second absolute path stays its own placeholder');
  // The reviewer's low3 probe: a drive path behind a rooted one — the ':' keeps
  // them apart instead of collapsing both into one placeholder.
  const homeTwo = await nativeScrub(() => `copy ${rooted} D:\\work\\b.png`);
  assert.equal(homeTwo.error, 'copy <home> <path>', 'a drive path after a root stays its own placeholder');
});

test('scrub rework a4 中1: mixed separators inside a spaced root path stay one placeholder', async () => {
  // Regression from a3: the family rule required the continuation token to
  // carry the SAME separator kind, so `My Docs/secret.png` (mixed) leaked
  // 'Docs/secret.png'. The ASCII-segment rule joins both separator kinds.
  const mixed = process.platform === 'win32'
    ? `${os.homedir()}\\My Docs/secret.png`
    : `${os.homedir()}/My Docs/secret.png`;
  const { error } = await nativeScrub(() => `open ${mixed}`);
  assert.equal(error, 'open <home>', 'the mixed-separator spaced path collapses to <home>');
});

test('scrub rework a4 低1: a trailing spaced segment without a separator joins too', async () => {
  const p = process.platform === 'win32' ? `${os.homedir()}\\My Docs` : `${os.homedir()}/My Docs`;
  const { error } = await nativeScrub(() => `open ${p}`);
  assert.equal(error, 'open <home>', 'the last spaced segment is part of the rooted path');
});

// ── Hermetic scrub pins (a4 中2): the same shared segment source is fed plain
//    strings, so the POSIX branch is pinned on win32 as well and no test has
//    to pick "the other family" to stay green.
const hermeticScrub = (text: string): string =>
  scrubShotPath(text, null, path.join(os.tmpdir(), 'hb-hermetic', 'tmp'), path.join(os.tmpdir(), 'hb-hermetic'));

test('scrub hermetic: the shared tail keeps prose, URLs and second paths out', () => {
  assert.equal(typeof VISION_PATH_TAIL_SOURCE, 'string');
  assert.equal(VISION_PATH_TAIL_SOURCE.length > 0, true);
  assert.equal(hermeticScrub('open D:\\probe\\a.png 读取/写入失败'), 'open <path> 读取/写入失败');
  assert.equal(hermeticScrub('open D:\\probe\\a.png (open/read failed)'), 'open <path> (open/read failed)');
  assert.equal(hermeticScrub('open D:\\probe\\a.png https://example.com/api/x'), 'open <path> https://example.com/api/x');
  assert.equal(hermeticScrub('open /srv/probe/a.png 读取/写入失败'), 'open <path> 读取/写入失败');
  assert.equal(hermeticScrub('open /srv/probe/a.png (open/read failed)'), 'open <path> (open/read failed)');
  assert.equal(hermeticScrub('copy D:\\probe\\a.png E:\\work\\b.png'), 'copy <path> <path>');
});

test('scrub hermetic: ASCII segments join, CJK prose never does (POSIX pinned on win32)', () => {
  assert.equal(hermeticScrub('open /srv/probe/My Docs/secret.png'), 'open <path>');
  assert.equal(hermeticScrub('open /srv/probe/My Docs'), 'open <path>');
  assert.equal(hermeticScrub('open D:\\probe\\My Docs\\secret.png'), 'open <path>');
  // A first-level home's sibling has one segment only and must still be hidden.
  assert.equal(hermeticScrub('open /root.bak'), 'open <path>');
  assert.equal(hermeticScrub('open /root.bak/secret'), 'open <path>');
});

test('scrub hermetic: an errno or upstream note glued to the path is kept (a4 低2)', () => {
  assert.equal(hermeticScrub('open D:\\probe\\a.png:ENOENT'), 'open <path>:ENOENT');
  assert.equal(hermeticScrub('open D:\\probe\\a.png[truncated by CLI]'), 'open <path>[truncated by CLI]');
  assert.equal(hermeticScrub('open /srv/probe/a.png:ENOENT'), 'open <path>:ENOENT');
});

test('scrub rework a5 H1: the ASCII-continuation trade-off is pinned', () => {
  // The documented cost of "a continuation across a space must be ASCII": a
  // NON-ASCII path segment after the space ends the match and its remainder
  // stays as text. Pinned exactly as implemented — do not treat this as a bug
  // fix request without also accepting the CJK-prose cases being swallowed.
  assert.equal(hermeticScrub('open D:\\probe\\My Docs\\截图.png'), 'open <path>截图.png');
  assert.equal(
    hermeticScrub('open C:\\Program Files (x86)\\app\\x.png'),
    'open <path> Files (x86)\\app\\x.png',
  );
  assert.equal(hermeticScrub('open D:\\probe\\My Docs\\app+extra\\x.png'), 'open <path>+extra\\x.png');
  assert.equal(hermeticScrub('open D:\\probe\\My Docs  double\\x.png'), 'open <path> Docs  double\\x.png');
});

test('scrub rework a5 H2: a bare trailing word after a path is consumed (pinned)', () => {
  // Accepted cost of the "bare last word" continuation: `My Docs` and
  // `failed` have the same shape, so the diagnostic word goes with the path.
  assert.equal(hermeticScrub('open /srv/probe/a.png failed'), 'open <path>');
  // A ':' behind the word keeps it out of the path, so errno-style tails stay.
  // This is the DOTTED branch's live lookahead (a5 低2): a bare last word is
  // delimited by end-of-text, not by this ':' guard.
  assert.equal(hermeticScrub('open /srv/probe/a.png failed: ENOENT'), 'open <path> failed: ENOENT');
});

test('scrub rework a5 低3: any non-segment character after a space ends the path (pinned)', () => {
  // Scope correction for the documented trade-off: the cut is not ASCII-vs-CJK,
  // it is "any character outside [A-Za-z0-9_.~$-]". '=', '@', ',', ';' and Tab
  // all end the continuation the same way, and the remainder stays readable in
  // the audit line (accepted cost, pinned as implemented).
  assert.equal(hermeticScrub('open D:\\probe\\My Docs=a\\x.png'), 'open <path> Docs=a\\x.png');
  assert.equal(hermeticScrub('open D:\\probe\\My Docs@work\\x.png'), 'open <path> Docs@work\\x.png');
  assert.equal(hermeticScrub('open D:\\probe\\My Docs,drop\\x.png'), 'open <path> Docs,drop\\x.png');
  assert.equal(hermeticScrub('open D:\\probe\\My Docs;drop\\x.png'), 'open <path> Docs;drop\\x.png');
  assert.equal(hermeticScrub('open D:\\probe\\My Docs\tx.png'), 'open <path> Docs\tx.png');
  // The SEG class itself keeps a plain spaced value path whole.
  assert.equal(hermeticScrub('open D:\\probe\\My Docs\\x.png'), 'open <path>');
});

test('scrub rework a5 低1: trailing punctuation and the bare basename have pins', async () => {
  // TRAILING_PUNCT puts the delimiter back after the placeholder…
  const homeShot = path.join(os.homedir(), 'a.png');
  const paren = await nativeScrub(() => `open ${homeShot})`);
  assert.equal(paren.error, 'open <home>)', 'the closing parenthesis is restored');
  assert.equal(hermeticScrub('open D:\\probe\\a.png,'), 'open <path>,', 'the comma is restored');

  // …and the shot's bare basename is scrubbed even without its directory.
  const bare = await nativeScrub((shot) => `cannot open ${path.basename(shot)} (ENOENT)`);
  assert.equal(bare.error, 'cannot open <screenshot> (ENOENT)', 'the plain file name never reaches the audit');
});

test('scrub rework a5 低1b: a sentence-final period is restored after the placeholder', () => {
  // TRAILING_PUNCT carries '.' for the prose case ("cannot open …."): the dot
  // belongs to the sentence, not the path. Dropping it from the class eats it
  // and the audit line loses the sentence's full stop.
  assert.equal(hermeticScrub('cannot open D:\\probe\\a.png.'), 'cannot open <path>.');
  assert.equal(hermeticScrub('open /srv/probe/a.png.'), 'open <path>.');
  // A bare word becomes a path only through the dotted branch; the dot is
  // re-attached the same way.
  assert.equal(hermeticScrub('open /srv/probe/a.png. then failed'), 'open <path>. then failed');
});

test('scrub rework a5 低2: a bare POSIX word is prose, not a path', () => {
  // Single-segment POSIX matches need a dotted file name (`/root.bak`) or a
  // second segment; `/api` / `/n` are ordinary prose and stay untouched.
  assert.equal(hermeticScrub('GET /api failed'), 'GET /api failed');
  assert.equal(hermeticScrub('escape /n sequence'), 'escape /n sequence');
  assert.equal(hermeticScrub('open /root.bak'), 'open <path>', 'a dotted single segment is still a path');
});

test('scrub rework a5 低3: a host:port behind a path stays out of the placeholder', () => {
  assert.equal(
    hermeticScrub('open /srv/probe/a.png 10.0.0.5:8080'),
    'open <path> 10.0.0.5:8080',
    'the lookahead keeps a dotted host:port from reading as a file name',
  );
});

test('scrub rework a3 低1: a path under the data dir root collapses to <data>', async () => {
  // A deployment whose data dir sits outside the main sandbox: the data-root
  // pass must name it before the broader tmp/home roots take the path (this is
  // the pin for replaceRoot(dataDir) and for its order ahead of tmp/home).
  // Tracked like the beforeEach sandboxes so the file-level `after` deletes and
  // asserts on it too (H6).
  const dataSandbox = sandboxDir('hb-vision-data-');
  createdSandboxes.push(dataSandbox);
  const dataRoot = path.join(dataSandbox, 'data');
  process.env.HEARTBEAT_DATA_DIR = dataRoot;
  resetWorkspaceForTest();
  initWorkspace();
  resetVaultKeyCacheForTest();
  // Re-point the module guard at the new data dir (beforeEach rebuilds it for
  // the next case, so this does not leak).
  guard = createPathGuard(workspace().dataDir);
  writeCurrentShot();
  const native = fakeTurn(async () => {
    throw new Error(`cannot open ${path.join(dataRoot, 'logs', 'x.jsonl')}`);
  });
  const vision = await describeScreenVision(guard, workspace(), {
    moduleUrl: import.meta.url,
    engine: 'native',
    turn: native.turn,
  });
  assert.equal(vision.ok, false);
  assert.equal(vision.error, 'cannot open <data>');
});

test('scrub rework a3 低2: a spaced segment inside a rooted path is one placeholder', async () => {
  const p = path.join(os.homedir(), 'My Docs', 'secret.png');
  const { error } = await nativeScrub(() => `open ${p}`);
  assert.equal(error, 'open <home>', 'the spaced segment stays part of the rooted path');
});

test('scrub rework a3 低3: a case-folded root is still the root', async () => {
  // The root components match with 'gi'; this is the pin for that claim.
  const p = path.join(os.homedir(), 'secret', 'x.png').toUpperCase();
  const { error } = await nativeScrub(() => `open ${p}`);
  assert.equal(error, 'open <home>');
});

test('scrub N27: mixed-case roots fold to <home>/<tmp> (case-insensitive root match)', () => {
  // The 'gi' flag on replaceRoot exists for win32's case-preserving,
  // case-insensitive paths: a formatter may fold the drive letter or a
  // directory name. Every variant is a transform of os.homedir()/os.tmpdir()
  // (nothing machine-specific is written down), and the assertion is
  // string-level, so it holds on case-sensitive hosts as well. 'g' instead of
  // 'gi' leaves the root pass without a match and the shape fallback turns the
  // path into <path> — both assertions below red.
  const driveFold = (p: string) => p.replace(/^[A-Za-z]:/, (m) => m.toLowerCase());
  const rootFold = (root: string) => path.join(path.dirname(root), path.basename(root).toUpperCase());

  for (const root of [os.homedir(), os.tmpdir()]) {
    const placeholder = root === os.homedir() ? '<home>' : '<tmp>';
    const plain = path.join(root, 'hb-probe-case', 'shot.png');
    for (const variant of [driveFold(plain), path.join(rootFold(root), 'hb-probe-case', 'shot.png')]) {
      assert.equal(hermeticScrub(`open ${variant}`), `open ${placeholder}`, `${variant} must fold to ${placeholder}`);
    }
    // The variant really differs from the literal root (otherwise the loop
    // would only re-pin the plain path).
    assert.equal(driveFold(plain) === plain && path.join(rootFold(root), 'hb-probe-case', 'shot.png') === plain, false);
  }
});

test('scrub N25①: a UNC path in the error text is replaced whole (fallback)', async () => {
  const { error } = await nativeScrub(() => 'modlens exit 2: cannot open \\\\fileserver\\share\\hb-probe\\shot.png (ENOENT)');
  assert.ok(error.includes('<path>'), 'the UNC share path is replaced by the fallback placeholder');
  assert.ok(!error.includes('fileserver'), 'the server name never reaches the audit');
  assert.ok(!error.includes('share'), 'the share name never reaches the audit');
  assert.ok(error.includes('(ENOENT)'), 'the error reason is preserved, not swallowed');
});

test('scrub N25①: ordinary error text without a path is left untouched', async () => {
  // Guards the fallback against becoming an unconditional "swallow the line".
  const plain = await nativeScrub(() => 'modlens returned no summary');
  assert.equal(plain.error, 'modlens returned no summary', 'non-path text passes through byte-for-byte');
  // A URL is not a path either — 'https://…' must not read as a drive letter.
  const url = 'fetch failed: https://example.com/api (timeout)';
  const fetched = await nativeScrub(() => url);
  assert.equal(fetched.error, url, 'a URL keeps its scheme and host');
});

test('native: an already-cancelled beat never decrypts the shot (A6 低5)', async () => {
  // engine='native' used to unlock (decrypt) the shot first and only then let
  // the router's abort check throw — a cancelled beat still wrote the plaintext
  // to disk. The entry guard must stop BEFORE the unlock/turn.
  writeCurrentShot();
  const native = fakeTurn(async () => '在写代码');
  const ctl = new AbortController();
  ctl.abort('beat watchdog');
  await assert.rejects(
    describeScreenVision(guard, workspace(), {
      moduleUrl: import.meta.url,
      engine: 'native',
      turn: native.turn,
      signal: ctl.signal,
    }),
    (e: unknown) => e instanceof BeatAbortedError
      && (e as BeatAbortedError).stage === 'vision'
      && /signal already dead before native run/.test((e as BeatAbortedError).why),
  );
  assert.equal(native.calls.length, 0, 'the cancelled beat never reached the turn');
  assert.deepEqual(leftoverPlaintext(), [], 'nothing was unlocked (and nothing was left to burn)');
});

test('native: a SUCCESS on a dead signal is discarded — never returned as ok:true (A6 低6)', async () => {
  // The router's post-native check must fire on the SIGNAL, not on native.ok:
  // `if (opts.signal?.aborted && !native.ok)` would hand back ok:true for a
  // beat that is already unwinding (and the caller would book screen_vision ok).
  writeCurrentShot();
  const ctl = new AbortController();
  const native = fakeTurn(async () => {
    ctl.abort('beat watchdog'); // the read succeeds while the beat is unwinding
    return '在写代码';
  });
  await assert.rejects(
    describeScreenVision(guard, workspace(), {
      moduleUrl: import.meta.url,
      engine: 'native',
      turn: native.turn,
      signal: ctl.signal,
    }),
    /vision aborted \(beat cancelled mid-read\)/,
  );
  assert.equal(native.calls.length, 1, 'the read really succeeded — only the booking changes');
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

test('visionEngine: an invalid non-empty value reads as unset, never as "has a value" (N3)', () => {
  // The old `config.trim() || ui.trim()` let config='bogus' shadow a deliberate
  // card='modlens', which downstream coercion then silently ran as auto.
  const shadowed = resolveVisionEngineSetting('bogus', 'modlens');
  assert.equal(shadowed.value, 'modlens', 'the card value is not shadowed by an invalid config value');
  assert.deepEqual(shadowed.invalid, [{ source: 'config', value: 'bogus' }]);
  // No next input: an invalid value follows vision.json (''), it is NOT auto.
  assert.equal(resolveVisionEngineSetting('bogus', '').value, '');
  assert.deepEqual(resolveVisionEngineSetting('bogus', '').invalid, [{ source: 'config', value: 'bogus' }]);
  // An invalid CARD value behaves the same one layer down.
  const badCard = resolveVisionEngineSetting('', 'NATIVE');
  assert.equal(badCard.value, '');
  assert.deepEqual(badCard.invalid, [{ source: 'card', value: 'NATIVE' }]);
  // The three literals (trimmed) survive both inputs; clean inputs report nothing.
  assert.equal(resolveVisionEngineSetting(' native ', '').value, 'native');
  assert.equal(resolveVisionEngineSetting('', ' auto ').value, 'auto');
  assert.equal(resolveVisionEngineSetting('modlens', 'native').value, 'modlens', 'config wins when both are valid');
  assert.deepEqual(resolveVisionEngineSetting('', '').invalid, []);
});

test('visionEngine: the same invalid value audits exactly once across beats (N18)', () => {
  // The resolver runs every beat; a typo must produce ONE audit row total.
  const seen = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  const invalid = [{ source: 'config' as const, value: 'bogus' }];
  auditInvalidVisionEngines(invalid, seen, (e) => { rows.push(e); }); // beat 1
  auditInvalidVisionEngines(invalid, seen, (e) => { rows.push(e); }); // beat 2
  auditInvalidVisionEngines(invalid, seen, (e) => { rows.push(e); }); // beat 3
  // spread: deepEqual is an assertion (`asserts actual is T`) in @types/node
  // and would narrow `rows` to the literal tuple, breaking the later pushes.
  assert.deepEqual([...rows], [{ event: 'vision_engine_invalid', source: 'config', value: 'bogus' }]);
  // A NEW value gets its own row — the dedup must not over-suppress.
  auditInvalidVisionEngines([{ source: 'config', value: 'bogus2' }], seen, (e) => { rows.push(e); });
  assert.equal(rows.length, 2);
});

test('visionEngine: config AND card both invalid (different values) — two rows on beat 1, no growth after (N18)', () => {
  // Premise (rework 低3, stated honestly): production never feeds this shape —
  // ui-config's sanitize drops the card side, so at most ONE config-side
  // invalid value reaches the helper. This is a DIRECT-CALL construction
  // scenario pinning the helper's own contract (keyed dedup converges), not a
  // reproduction of a production bug; the old single-slot memory was adequate
  // on the production path, and the Set is a defensive improvement.
  const seen = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  const invalid = [{ source: 'config' as const, value: 'bogus' }, { source: 'card' as const, value: 'NATIVE' }];
  auditInvalidVisionEngines(invalid, seen, (e) => { rows.push(e); }); // beat 1
  assert.deepEqual([...rows], [
    { event: 'vision_engine_invalid', source: 'config', value: 'bogus' },
    { event: 'vision_engine_invalid', source: 'card', value: 'NATIVE' },
  ]);
  auditInvalidVisionEngines(invalid, seen, (e) => { rows.push(e); }); // beat 2
  auditInvalidVisionEngines(invalid, seen, (e) => { rows.push(e); }); // beat 3
  assert.equal(rows.length, 2, 'no growth after the first beat');
});

test('auditInvalidVisionEngines: a failed write does not consume the key — it retries next beat (N18 rework 低1)', () => {
  // The mark was previously made BEFORE the write, so one thrown write
  // permanently consumed the key: the reviewer's probe (first write throws,
  // then three normal beats) ended with rows=0 — the typo silenced forever.
  // The key must only be recorded once the write actually succeeded.
  const seen = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  let failFirst = true;
  const flakyWrite = (e: Record<string, unknown>) => {
    if (failFirst) {
      failFirst = false;
      throw new Error('audit disk full');
    }
    rows.push(e);
  };
  const invalid = [{ source: 'config' as const, value: 'bogus' }];
  auditInvalidVisionEngines(invalid, seen, flakyWrite); // write throws — key must NOT be consumed
  assert.equal(rows.length, 0, 'the failed write produced no row');
  auditInvalidVisionEngines(invalid, seen, (e) => { rows.push(e); }); // next beat: must retry
  assert.equal(rows.length, 1, 'the typo is not silenced by the earlier failed write');
  assert.deepEqual([...rows], [{ event: 'vision_engine_invalid', source: 'config', value: 'bogus' }]);
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
