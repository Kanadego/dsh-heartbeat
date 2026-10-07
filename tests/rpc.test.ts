// H-85: regression cover for the settings-card RPC surface. The route is the
// plugin's only inbound browser entry point and had no test file at all.
//
// The fake context mirrors the host contract `installHeartbeatRpc` depends on:
// `ctx.inject(['connection'], cb)` hands back a scoped context whose
// `connection.fetch.register()` we capture, plus `agents` and `effect`.

import { sandboxDir } from './_sandbox.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import { loadPolicy } from '../src/config/load.js';
import type { Policy } from '../src/config/schema.js';
import { saveEncryptedText } from '../src/vault/vault.js';
import { gateFilePath } from '../src/core/orchestrator.js';
import { bindingsFilePath } from '../src/core/bindings.js';
import { installHeartbeatRpc, RPC_ROUTE_PATH } from '../src/rpc.js';

interface Route {
  path: string;
  methods: string[];
  requestBody?: string;
  fetch(request: Request): Promise<Response>;
}

interface RpcResult {
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string };
}

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;
let policy: Policy;
let route: Route;
let configValue: Record<string, unknown>;
let setCalls: unknown[];
let uiGetThrows = false;

const UI_DEFAULTS = {
  intervalMin: 20,
  maxDailySend: 3,
  timeInjectMin: 25,
  statusbar: true,
  idleMode: false,
  tokenSaver: false,
  psyEnabled: false,
};

beforeEach(() => {
  sandbox = sandboxDir('hb-rpc-');
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  guard = createPathGuard(workspace().dataDir);
  policy = loadPolicy(guard, workspace().configDir, workspace().settingsDir);
  configValue = { ...UI_DEFAULTS };
  setCalls = [];
  uiGetThrows = false;

  const ui = {
    get: () => {
      if (uiGetThrows) throw new Error('runtime not initialized');
      return { ...configValue };
    },
    set: (patch: unknown) => {
      setCalls.push(patch);
      Object.assign(configValue, patch as Record<string, unknown>);
    },
  };

  let captured: Route | undefined;
  const scoped = {
    connection: {
      // H-41: the host's /api gate (`connection.admit` → `requestRejection`).
      // Its presence is what lets the destructive endpoints serve at all.
      admit() { /* host gate */ },
      fetch: {
        register(r: Route) { captured = r; return () => { /* dispose */ }; },
      },
    },
    agents: { get: () => undefined },
    effect(fn: () => unknown) { fn(); return () => { /* dispose */ }; },
  };
  const ctx = {
    inject(_services: string[], callback: (s: unknown) => void) { callback(scoped); },
    logger: { info() { /* quiet */ } },
  };

  installHeartbeatRpc(
    ctx as never,
    { paths: workspace(), guard, policy, ui } as never,
  );
  assert.ok(captured, 'the route must be registered during install');
  route = captured;
});

after(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

async function callRaw(body: string): Promise<Response> {
  return route.fetch(new Request('http://127.0.0.1/api/heartbeat', { method: 'POST', body }));
}

async function call(envelope: unknown): Promise<Response> {
  return callRaw(JSON.stringify(envelope));
}

async function result(payload: unknown): Promise<RpcResult> {
  const res = await call({ type: 'client-request', rpcId: 'r1', payload });
  assert.equal(res.status, 200);
  const body = await res.json() as { type: string; rpcId: string; result: RpcResult };
  assert.equal(body.type, 'server-response');
  assert.equal(body.rpcId, 'r1');
  return body.result;
}

// ── route registration ───────────────────────────────────────────────────

test('the card route is registered under /api, POST, buffered body', () => {
  assert.equal(route.path, RPC_ROUTE_PATH);
  assert.deepEqual(route.methods, ['POST']);
  assert.equal(route.requestBody, 'buffered');
});

// ── envelope validation ──────────────────────────────────────────────────

test('a non-JSON body is rejected with 400 before any endpoint runs', async () => {
  const res = await callRaw('not json at all');
  assert.equal(res.status, 400);
  assert.equal(await res.text(), 'body is not JSON');
});

test('a malformed envelope is rejected with 400', async () => {
  const cases: unknown[] = [
    { type: 'server-response', rpcId: 'r1', payload: {} },  // wrong type
    { type: 'client-request', rpcId: 7, payload: {} },      // rpcId not a string
    { type: 'client-request', rpcId: 'r1', payload: null }, // null payload
    { type: 'client-request', rpcId: 'r1', payload: 'x' },  // payload not an object
  ];
  for (const envelope of cases) {
    const res = await call(envelope);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(envelope)}`);
    assert.equal(await res.text(), 'invalid envelope');
  }
});

test('an unknown endpoint is a bad-request result, not a 5xx', async () => {
  const r = await result({ endpoint: 'no.such.endpoint' });
  assert.equal(r.ok, false);
  assert.equal(r.error!.code, 'bad-request');
  assert.match(r.error!.message, /unknown endpoint/);
});

test('a throwing endpoint is reported as an internal error, never as a crash', async () => {
  uiGetThrows = true;
  const r = await result({ endpoint: 'config.get' });
  assert.equal(r.ok, false);
  assert.equal(r.error!.code, 'internal');
  assert.match(r.error!.message, /runtime not initialized/);
});

// ── bindings ─────────────────────────────────────────────────────────────

test('bindings.get: an empty workspace reports an empty binding list', async () => {
  const r = await result({ endpoint: 'bindings.get' });
  assert.equal(r.ok, true);
  assert.deepEqual((r.value as { bindings: unknown[] }).bindings, []);
});

test('bindings.add: only session-… ids are accepted, and the file is written', async () => {
  const bad = await result({ endpoint: 'bindings.add', sessionId: 'lobby' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error!.code, 'bad-request');

  const good = await result({ endpoint: 'bindings.add', sessionId: 'session-abc', observe: true });
  assert.equal(good.ok, true);
  assert.equal((good.value as { sessionId: string }).sessionId, 'session-abc');
  assert.equal((good.value as { deliver: boolean }).deliver, true, 'deliver defaults on');
  assert.equal((good.value as { observe: boolean }).observe, true);

  const saved = JSON.parse(fs.readFileSync(bindingsFilePath(workspace().settingsDir), 'utf8')) as { bindings: unknown[] };
  assert.equal(saved.bindings.length, 1);
});

test('bindings.add: the home session cannot be bound (the decision always runs there)', async () => {
  saveEncryptedText(guard, gateFilePath(workspace()), JSON.stringify({ sessionId: 'session-home' }));
  const r = await result({ endpoint: 'bindings.add', sessionId: 'session-home' });
  assert.equal(r.ok, false);
  assert.equal(r.error!.code, 'bad-request');
  assert.match(r.error!.message, /正身/);
});

test('H-09/H-45: bindings.remove on the home releases gate.json through the shared path', async () => {
  const home = 'session-home';
  saveEncryptedText(guard, gateFilePath(workspace()), JSON.stringify({ sessionId: home }));
  await result({ endpoint: 'bindings.add', sessionId: home }); // refused, but harmless here

  const r = await result({ endpoint: 'bindings.remove', sessionId: home });
  assert.equal(r.ok, true);
  const value = r.value as { removed: boolean; homeReset: boolean };
  assert.equal(value.homeReset, true, 'removing the home must reset it');
  assert.equal(fs.existsSync(gateFilePath(workspace())), false);

  const audit = fs.readFileSync(path.join(workspace().logsDir, 'heartbeat.jsonl'), 'utf8');
  assert.match(audit, /"event":"home_reset"/);
  assert.match(audit, /session-home/);
});

test('bindings.remove: a foreign id leaves the gate file alone', async () => {
  saveEncryptedText(guard, gateFilePath(workspace()), JSON.stringify({ sessionId: 'session-home' }));
  const r = await result({ endpoint: 'bindings.remove', sessionId: 'session-other' });
  assert.equal(r.ok, true);
  assert.equal((r.value as { homeReset: boolean }).homeReset, false);
  assert.equal(fs.existsSync(gateFilePath(workspace())), true);
});

// ── config ───────────────────────────────────────────────────────────────

test('config.get: the card reads the seven live values', async () => {
  const r = await result({ endpoint: 'config.get' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, UI_DEFAULTS);
});

test('config.set: an empty or unrecognised patch is a bad-request', async () => {
  const none = await result({ endpoint: 'config.set' });
  assert.equal(none.ok, false);
  assert.equal(none.error!.code, 'bad-request');
  assert.match(none.error!.message, /no recognized field/);

  const unknownKey = await result({ endpoint: 'config.set', nope: 1 });
  assert.equal(unknownKey.ok, false);
});

test('config.set: a recognised patch goes to the setter and is audited', async () => {
  const r = await result({ endpoint: 'config.set', intervalMin: 45, maxDailySend: 5 });
  assert.equal(r.ok, true);
  assert.equal(setCalls.length, 1);
  assert.equal((r.value as { intervalMin: number }).intervalMin, 45);

  const audit = fs.readFileSync(path.join(workspace().logsDir, 'heartbeat.jsonl'), 'utf8');
  assert.match(audit, /ui_config_set/);
  assert.match(audit, /intervalMin/);
});

// ── read-only listings ───────────────────────────────────────────────────

test('seeds.list / interests.list on an empty workspace answer ok, not an error', async () => {
  const seeds = await result({ endpoint: 'seeds.list' });
  assert.equal(seeds.ok, true);
  const sv = seeds.value as { active: unknown[]; archived: unknown[]; cap: number };
  assert.deepEqual(sv.active, []);
  assert.deepEqual(sv.archived, []);
  assert.equal(typeof sv.cap, 'number');

  const interests = await result({ endpoint: 'interests.list' });
  assert.equal(interests.ok, true);
  assert.ok(interests.value, 'the effective interests document is returned');
});

test('seeds.archive with an unknown id is a not-found result', async () => {
  const r = await result({ endpoint: 'seeds.archive', id: 's-nope' });
  assert.equal(r.ok, false);
  assert.equal(r.error!.code, 'not-found');
});

// ── H-41: the host gate is a declared dependency, not an assumption ──────

test('H-41: without the host gate the destructive endpoints are refused, read-only ones still serve', async () => {
  let captured: Route | undefined;
  const scoped = {
    connection: {
      // No `admit` / `requestRejection` — a host that dropped the /api gate.
      fetch: { register(r: Route) { captured = r; return () => { /* dispose */ }; } },
    },
    agents: { get: () => undefined },
    effect(fn: () => unknown) { fn(); return () => { /* dispose */ }; },
  };
  const ctx = {
    inject(_services: string[], callback: (s: unknown) => void) { callback(scoped); },
    logger: { info() { /* quiet */ } },
  };
  const ui = { get: () => ({ ...UI_DEFAULTS }), set: () => { /* unused */ } };
  installHeartbeatRpc(ctx as never, { paths: workspace(), guard, policy, ui } as never);
  assert.ok(captured, 'the route still registers so the read-only card keeps working');

  const post = async (payload: Record<string, unknown>): Promise<RpcResult> => {
    const res = await captured!.fetch(new Request('http://127.0.0.1/api/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', payload }),
    }));
    const body = (await res.json()) as { result: RpcResult };
    return body.result;
  };

  const refused = await post({ endpoint: 'seeds.delete', id: 's-nope' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error!.code, 'forbidden');
  assert.match(refused.error!.message, /H-41/);

  const allowed = await post({ endpoint: 'seeds.list' });
  assert.equal(allowed.ok, true);

  const audit = fs.readFileSync(path.join(workspace().logsDir, 'heartbeat.jsonl'), 'utf8');
  assert.match(audit, /rpc_host_gate_missing/);
});
