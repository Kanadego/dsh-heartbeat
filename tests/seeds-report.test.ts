// seed_report tool (2026-10-06): the persona's unified bookkeeping channel —
// schema enforcement, ring trim, window reads. Tool execute() stores raw ids;
// package validation happens at reconciliation (orchestrator), not here.
// DPAPI vault shells out per read/write, so tests batch whole files.
import { sandboxDir } from './_sandbox.js';
import { test, beforeEach, after } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard, type PathGuard } from '../src/core/path-guard.js';
import { saveEncryptedText } from '../src/vault/vault.js';
import {
  REPORT_KEEP,
  REPORT_REASONS,
  appendSeedReport,
  buildSeedReportTool,
  readSeedReports,
  readSeedReportsSince,
  reportFilePath,
  type SeedReportEntry,
} from '../src/seeds/report.js';
import { MATERIAL_MISMATCH_REASON } from '../src/core/material.js';

// vault (DPAPI) needs the workspace singleton for tmp windows + vault.ps1
let sandbox = '';
beforeEach(() => {
  sandbox = sandboxDir('hb-report-');
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
});
after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
});

function makeTool(): {
  dir: string;
  guard: PathGuard;
  file: string;
  tool: { execute(args: unknown): Promise<{ ok: boolean; message: string }> };
} {
  const dir = workspace().dataDir;
  const guard = createPathGuard(dir);
  const file = reportFilePath(dir);
  return { dir, guard, file, tool: buildSeedReportTool(guard, file) as {
    execute(args: unknown): Promise<{ ok: boolean; message: string }>;
  } };
}

test('seed_report execute: material requires seed_ids; silent stores a bare fact', async () => {
  const { tool } = makeTool();
  const bad = await tool.execute({ spoken: 'material' });
  assert.equal(bad.ok, false);
  assert.ok(bad.message.includes('seed_ids'));

  const ok = await tool.execute({ spoken: 'material', seed_ids: ['s3', ' s5 '] });
  assert.equal(ok.ok, true);
  const silent = await tool.execute({ spoken: 'silent', reason: '在忙或刚聊过' });
  assert.equal(silent.ok, true);

  const junk = await tool.execute({ spoken: 'nope' });
  assert.equal(junk.ok, false);
});

test('seed_report execute: reason only rides on non-material reports', async () => {
  const { guard, file, tool } = makeTool();
  await tool.execute({ spoken: 'material', seed_ids: ['s1'], reason: '素材不搭' });
  const [e] = readSeedReports(guard, file);
  assert.equal(e!.spoken, 'material');
  assert.equal(e!.reason, undefined, 'material reports are about ids; reason would muddle aggregates');
  assert.deepEqual(e!.seedIds, ['s1']);
});

test('ring: one report past REPORT_KEEP drops the oldest, newest last; window reads filter by ts', async () => {
  const { guard, file } = makeTool();
  const now = Date.now();
  // batch the pre-existing ring as ONE encrypted write (vault spawns saved)
  const backlog = Array.from({ length: REPORT_KEEP }, (_, i) =>
    JSON.stringify({ ts: now - 10_000 + i, spoken: 'silent', seedIds: [], profileIds: [] }));
  await saveEncryptedText(guard, file, backlog.join('\n') + '\n');

  appendSeedReport(guard, file, { ts: now + 1, spoken: 'heartfelt', seedIds: [], profileIds: [] });
  const all = readSeedReports(guard, file);
  assert.equal(all.length, REPORT_KEEP, 'ring stays at the cap');
  assert.ok(all[0]!.ts > now - 10_000, 'oldest entry was dropped');
  assert.ok(all[0]!.ts < all[all.length - 1]!.ts, 'still oldest first');
  assert.equal(all[all.length - 1]!.ts, now + 1);

  const win = readSeedReportsSince(guard, file, now + 1);
  assert.equal(win.length, 1, 'only entries at/after the window mark');
});

test('v1.9.0: ids are accepted in the shapes a model actually writes ([s3] / "s3")', async () => {
  const { guard, file, tool } = makeTool();
  const ok = await tool.execute({ spoken: 'material', seed_ids: ['[s3]', ' "s5" ', '`s7`', '{s9}', ' s1 '] });
  assert.equal(ok.ok, true);
  const [e] = readSeedReports(guard, file);
  // brackets/quotes/backticks/braces stripped, whitespace gone — package ids are bare
  assert.deepEqual(e!.seedIds, ['s3', 's5', 's7', 's9', 's1']);
  // and the reason list still names the material-mismatch reason this module shares with material.ts
  assert.ok((REPORT_REASONS as readonly string[]).includes(MATERIAL_MISMATCH_REASON));
});

test('v1.9.0: the delivery id round-trips through the ring and the window read', async () => {
  const { guard, file, tool } = makeTool();
  const stamp = Date.now();
  await tool.execute({ spoken: 'heartfelt', delivery_id: `  d${stamp}  ` });
  const [e] = readSeedReports(guard, file);
  assert.equal(e!.deliveryId, `d${stamp}`);
  const win = readSeedReportsSince(guard, file, stamp - 1);
  assert.equal(win.length, 1);
  assert.equal(win[0]!.deliveryId, `d${stamp}`);
  // an over-long id is clipped, never stored whole
  const huge = 'd' + 'x'.repeat(200);
  await tool.execute({ spoken: 'heartfelt', delivery_id: huge });
  const all = readSeedReports(guard, file);
  assert.equal(all[all.length - 1]!.deliveryId!.length, 64);
});

test('readSeedReports: corrupt lines skipped, unknown reason dropped, non-string ids filtered', () => {
  const { guard, file } = makeTool();
  // plaintext file on purpose: parse tolerance is file-format independent
  const lines = [
    JSON.stringify({ ts: 1, spoken: 'heartfelt', seedIds: [], profileIds: [], reason: '素材不搭' }),
    'not-json',
    JSON.stringify({ ts: 2, spoken: 'material', seedIds: ['ok', 5, null, ''], profileIds: [], reason: '乱写的' }),
    JSON.stringify({ ts: 'bogus', spoken: 'silent' }),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  const all = readSeedReports(guard, file);
  assert.equal(all.length, 2);
  assert.equal(all[1]!.seedIds.join(','), 'ok');
  assert.equal(all[1]!.reason, undefined);
});
