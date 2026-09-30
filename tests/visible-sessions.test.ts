import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadVisibleSessionIds } from '../src/rpc.js';

function writeRegistry(registry: unknown): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hb-vis-')), 'workspace.json');
  fs.writeFileSync(file, JSON.stringify(registry), 'utf8');
  return file;
}

test('loadVisibleSessionIds: hides archived (both prefix styles); subagents excluded by non-membership', () => {
  const file = writeRegistry({
    global: {
      archivedSessionIds: [
        'session-archived-prefixed',
        'archived-unprefixed', // archived list mixes prefixed/unprefixed forms
      ],
    },
    tables: {
      workspaces: {
        ws1: { sessionIds: ['session-keep', 'session-archived-prefixed'] },
        ws2: { sessionIds: ['session-other'] },
      },
    },
  });
  const { visible, registryFound } = loadVisibleSessionIds(file);
  assert.equal(registryFound, true);
  assert.equal(visible.has('session-keep'), true);
  assert.equal(visible.has('session-other'), true);
  assert.equal(visible.has('session-archived-prefixed'), false);
  assert.equal(visible.has('session-archived-unprefixed'), false);
  // subagent child sessions never join a workspace's sessionIds on disk, so
  // membership alone excludes them — verify a non-member stays invisible:
  assert.equal(visible.has('subagent-child'), false);
});

test('loadVisibleSessionIds: fails open on missing or corrupt registry', () => {
  const missing = loadVisibleSessionIds(path.join(os.tmpdir(), 'hb-vis-absent-workspace.json'));
  assert.equal(missing.registryFound, false);
  assert.equal(missing.visible.size, 0);

  const corrupt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hb-vis-')), 'workspace.json');
  fs.writeFileSync(corrupt, '{not json', 'utf8');
  const broken = loadVisibleSessionIds(corrupt);
  assert.equal(broken.registryFound, false);
  assert.equal(broken.visible.size, 0);
});
