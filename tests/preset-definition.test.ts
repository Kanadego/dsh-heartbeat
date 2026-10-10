// issue #2 (2026-10-10): the preset moved from a composition row naming
// `@deepseek-ai/dsh-agent-preset` to a runtime `agentPresets.register()` call.
// Cover the two things that fix depends on: the definition still says what the
// composition said, and no host shape can turn registration into a throw.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  heartbeatPresetDefinition,
  registerHeartbeatPreset,
  type HeartbeatPresetDefinition,
} from '../src/core/preset-definition.js';
import { bundledPresetDir, COMPOSITION_FILE } from '../src/core/preset-install.js';

const definition: HeartbeatPresetDefinition = heartbeatPresetDefinition();

test('definition keeps the composition identity', () => {
  assert.equal(definition.id, 'heartbeat');
  assert.equal(definition.order, 20);
  assert.equal(heartbeatPresetDefinition('custom').id, 'custom');
});

test('definition carries the compaction group and web_search-only tool row', () => {
  assert.equal(definition.plugins.length, 2);
  const [compaction, web] = definition.plugins;
  assert.equal(compaction?.id, 'compaction');
  assert.equal(compaction?.name, 'cordis:group');
  assert.equal(compaction?.group, true);
  assert.deepEqual(compaction?.isolate, { compaction: true, toolResultPruner: true });

  const children = (compaction?.config ?? []) as Array<{ id?: string; name?: string; config?: unknown }>;
  assert.deepEqual(children.map((c) => c.name), [
    '@deepseek-ai/dsh-compaction-basic',
    '@deepseek-ai/dsh-command-compact',
    '@deepseek-ai/dsh-compaction-tool-result-pruner',
  ]);
  assert.deepEqual(children[2]?.config, { thresholdChars: 8192, headChars: 4096, tailChars: 1024 });

  assert.equal(web?.name, '@deepseek-ai/dsh-tool-web');
  // fetch:false is the allow-list boundary (web_search without page fetching).
  assert.deepEqual(web?.config, { fetch: false, searchTimeoutMs: 60000 });
});

test('definition agrees with the shipped filesystem template', () => {
  const dir = bundledPresetDir(import.meta.url);
  assert.ok(dir, 'expected assets/presets/heartbeat beside the package');
  const yaml = fs.readFileSync(path.join(dir as string, COMPOSITION_FILE), 'utf8');
  // Row-level names and the two settings that encode the boundary.
  for (const name of [
    '@deepseek-ai/dsh-compaction-basic',
    '@deepseek-ai/dsh-command-compact',
    '@deepseek-ai/dsh-compaction-tool-result-pruner',
    '@deepseek-ai/dsh-tool-web',
  ]) {
    assert.ok(yaml.includes(name), `template should still name ${name}`);
  }
  assert.ok(yaml.includes('fetch: false'));
  assert.ok(yaml.includes('searchTimeoutMs: 60000'));
  assert.ok(yaml.includes('cordis:group'));
  // No persona row: the deployment persona (soul card) must not be shadowed.
  // The header comments mention `persona`, so match a row, not the word.
  assert.ok(!/^\s*-\s*id:\s*persona\b/m.test(yaml), 'the preset must not own a persona row');
});

test('registration calls the registry exactly once with the definition', async () => {
  const seen: unknown[] = [];
  const result = await registerHeartbeatPreset({ register: async (d: unknown) => { seen.push(d); return async () => {}; } }, 'heartbeat', true);
  assert.equal(result.action, 'registered');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], heartbeatPresetDefinition('heartbeat'));
});

test('a host without the API degrades instead of throwing', async () => {
  assert.equal((await registerHeartbeatPreset(undefined, 'heartbeat', true)).action, 'skipped-no-api');
  assert.equal((await registerHeartbeatPreset({}, 'heartbeat', true)).action, 'skipped-no-api');
  assert.equal((await registerHeartbeatPreset({ register: 'not-a-function' }, 'heartbeat', true)).action, 'skipped-no-api');
});

test('installPreset:false turns registration off too', async () => {
  let called = false;
  const result = await registerHeartbeatPreset({ register: async () => { called = true; return async () => {}; } }, 'heartbeat', false);
  assert.equal(result.action, 'skipped-disabled');
  assert.equal(called, false);
});

test('a rejecting registry is reported, not rethrown', async () => {
  const result = await registerHeartbeatPreset({ register: async () => { throw new Error('registry exploded'); } }, 'heartbeat', true);
  assert.equal(result.action, 'error');
  assert.match(result.detail ?? '', /registry exploded/);
});
