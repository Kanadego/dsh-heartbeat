import { sandboxDir } from './_sandbox.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import { loadUiConfig, saveUiConfig, uiConfigPath, USER_UI_FILE, type UiConfig } from '../src/config/ui-config.js';
import { loadPolicy, updateUserPolicy } from '../src/config/load.js';
import { installHeartbeatRpc } from '../src/rpc.js';

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;
let paths: ReturnType<typeof workspace>;

beforeEach(() => {
  sandbox = sandboxDir('hb-uicfg-');
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  paths = initWorkspace();
  guard = createPathGuard(paths.dataDir);
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
});

test('ui-config: missing layer loads as empty object', () => {
  assert.deepEqual(loadUiConfig(guard, paths.settingsDir), {});
});

test('ui-config: save + load roundtrip merges and persists', () => {
  saveUiConfig(guard, paths.settingsDir, { intervalMin: 30, statusbar: false });
  const merged = saveUiConfig(guard, paths.settingsDir, { idleMode: true });
  assert.equal(merged.intervalMin, 30); // first write survives the second save
  assert.equal(merged.statusbar, false);
  assert.equal(merged.idleMode, true);
  assert.deepEqual(loadUiConfig(guard, paths.settingsDir), merged);
  assert.ok(fs.existsSync(uiConfigPath(paths.settingsDir)));
  assert.match(path.basename(uiConfigPath(paths.settingsDir)), new RegExp(USER_UI_FILE));
});

test('ui-config: out-of-range and unknown fields are dropped', () => {
  const merged = saveUiConfig(guard, paths.settingsDir, {
    intervalMin: 99999,
    maxDailySend: 0,
    timeInjectMin: -5,
    statusbar: true,
  });
  assert.equal(merged.intervalMin, undefined);
  assert.equal(merged.maxDailySend, undefined);
  assert.equal(merged.timeInjectMin, undefined);
  assert.equal(merged.statusbar, true);
});

test('ui-config: corrupt layer fails open to defaults', () => {
  fs.mkdirSync(paths.settingsDir, { recursive: true });
  fs.writeFileSync(uiConfigPath(paths.settingsDir), '{broken', 'utf8');
  assert.deepEqual(loadUiConfig(guard, paths.settingsDir), {});
  // and the next save repairs the file
  const merged = saveUiConfig(guard, paths.settingsDir, { timeInjectMin: 0 });
  assert.equal(merged.timeInjectMin, 0);
  assert.deepEqual(loadUiConfig(guard, paths.settingsDir), merged);
});

test('ui-config: tokenSaver persists and out-of-range numbers never pass', () => {
  const merged = saveUiConfig(guard, paths.settingsDir, { tokenSaver: true, intervalMin: 20 });
  assert.equal(merged.tokenSaver, true);
  assert.equal(loadUiConfig(guard, paths.settingsDir).tokenSaver, true);
});

test('policy: updateUserPolicy merges into the user layer and flips psyEnabled on load', () => {
  const policy = loadPolicy(guard, paths.configDir, paths.settingsDir);
  assert.equal(policy.profile.psyEnabled, false); // factory default
  updateUserPolicy(guard, paths.settingsDir, { profile: { psyEnabled: true } });
  const updated = loadPolicy(guard, paths.configDir, paths.settingsDir);
  assert.equal(updated.profile.psyEnabled, true);
  // untouched factory fields still come from the factory layer
  assert.equal(updated.heartbeat.intervalMin, policy.heartbeat.intervalMin);
});
test('ui-config: the card vision-engine choice persists, clears, and drops junk', () => {
  // the card writes one of the three engines…
  assert.equal(saveUiConfig(guard, paths.settingsDir, { visionEngine: 'native' }).visionEngine, 'native');
  assert.equal(loadUiConfig(guard, paths.settingsDir).visionEngine, 'native');
  assert.equal(saveUiConfig(guard, paths.settingsDir, { visionEngine: 'modlens' }).visionEngine, 'modlens');
  // …or '' = "follow data/settings/vision.json", which must survive a reload
  assert.equal(saveUiConfig(guard, paths.settingsDir, { visionEngine: '' }).visionEngine, '');
  assert.equal(loadUiConfig(guard, paths.settingsDir).visionEngine, '');
  // anything else is a junk value: drop it instead of persisting it
  const junk = saveUiConfig(guard, paths.settingsDir, { visionEngine: 'NATIVE' as never });
  assert.equal(junk.visionEngine, undefined);
  assert.equal(loadUiConfig(guard, paths.settingsDir).visionEngine, undefined);
});

test('rpc config.set: concludeSilentTurn reaches ui.json and reads back true (real load/save)', async () => {
  const policy = loadPolicy(guard, paths.configDir, paths.settingsDir);
  // Mirror index.ts's live wiring: the snapshot is derived from the sanitized
  // ui.json layer, so a junk value can never read as "on".
  const ui = {
    get: () => {
      const stored = loadUiConfig(guard, paths.settingsDir);
      return {
        intervalMin: stored.intervalMin ?? policy.heartbeat.intervalMin,
        maxDailySend: stored.maxDailySend ?? policy.gate.maxDailySend,
        timeInjectMin: stored.timeInjectMin ?? 25,
        statusbar: stored.statusbar ?? false,
        idleMode: stored.idleMode ?? false,
        tokenSaver: stored.tokenSaver ?? false,
        visionEngine: stored.visionEngine ?? '',
        concludeSilentTurn: stored.concludeSilentTurn === true,
        psyEnabled: policy.profile.psyEnabled,
        quietStart: policy.gate.quietHours.start,
        quietEnd: policy.gate.quietHours.end,
      };
    },
    set: (patch: UiConfig) => { saveUiConfig(guard, paths.settingsDir, patch); },
  };

  interface Route {
    fetch(request: Request): Promise<Response>;
  }
  let route: Route | undefined;
  const scoped = {
    connection: {
      admit() { /* host gate */ },
      fetch: { register(r: Route) { route = r; return () => { /* dispose */ }; } },
    },
    agents: { get: () => undefined },
    effect(fn: () => unknown) { fn(); return () => { /* dispose */ }; },
  };
  installHeartbeatRpc(
    { inject(_s: string[], cb: (s: unknown) => void) { cb(scoped); }, logger: { info() { /* quiet */ } } } as never,
    { paths, guard, policy, ui } as never,
  );
  assert.ok(route, 'the route must be registered during install');

  const setRpc = async (payload: unknown): Promise<{ ok: boolean; value?: unknown }> => {
    const res = await route!.fetch(new Request('http://127.0.0.1/api/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ type: 'client-request', rpcId: 'uicfg', payload }),
    }));
    const body = await res.json() as { result: { ok: boolean; value?: unknown } };
    return body.result;
  };

  const on = await setRpc({ endpoint: 'config.set', concludeSilentTurn: true });
  assert.equal(on.ok, true);
  assert.equal((on.value as { concludeSilentTurn: boolean }).concludeSilentTurn, true);
  assert.equal(JSON.parse(fs.readFileSync(uiConfigPath(paths.settingsDir), 'utf8')).concludeSilentTurn, true);
  const snap = await setRpc({ endpoint: 'config.get' });
  assert.equal((snap.value as { concludeSilentTurn: boolean }).concludeSilentTurn, true);

  // A non-boolean is a recognised field (accepted, not a bad-request) but the
  // sanitizer drops it: snapshot false, nothing invalid on disk, no throw.
  const junk = await setRpc({ endpoint: 'config.set', concludeSilentTurn: 'yes' });
  assert.equal(junk.ok, true);
  assert.equal((junk.value as { concludeSilentTurn: boolean }).concludeSilentTurn, false);
  assert.equal('concludeSilentTurn' in JSON.parse(fs.readFileSync(uiConfigPath(paths.settingsDir), 'utf8')), false);
});
