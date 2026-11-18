import { sandboxDir } from './_sandbox.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import {
  appendEntry,
  correctionsDoneFilePath,
  correctionsFilePath,
  ledgerFilePath,
  readLedger,
  scanPending,
} from '../src/ledger/ledger.js';
import { buildCorrectionsTool } from '../src/ledger/tool.js';

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;
let tool: Record<string, any>;
let file = '';

beforeEach(() => {
  sandbox = sandboxDir('hb-corr-');
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  guard = createPathGuard(workspace().dataDir);
  file = correctionsFilePath(workspace().dataDir);
  tool = buildCorrectionsTool(guard, file) as Record<string, any>;
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
});

const run = async (args: unknown): Promise<{ ok: boolean; message: string }> =>
  (await tool.execute(args, {} as never)) as { ok: boolean; message: string };

test('definition carries the model-facing contract', () => {
  assert.equal(tool.name, 'corrections');
  assert.ok(String(tool.description).includes('纠正'));
  const params = tool.parameters as { type: string; required: string[]; properties: Record<string, { enum?: string[] }> };
  assert.equal(params.type, 'object');
  assert.deepEqual(params.required, ['action']);
  assert.deepEqual(params.properties.action!.enum, ['add', 'list', 'done']);
  assert.equal(typeof tool.output.render, 'function');
  assert.equal(tool.isConcurrencySafe({}), false); // read-modify-write on one file
});

test('first write seeds the 错题本 header, not the ledger one', async () => {
  await run({ action: 'add', text: '不确定的事别说成确定的' });
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(raw.startsWith('# 错题本'));
  assert.ok(!raw.includes('# 账本'));
});

test('add → list → done roundtrip speaks the 复盘 wording', async () => {
  const added = await run({ action: 'add', text: '  不确定的   事别说成确定的  ' });
  assert.equal(added.ok, true);
  assert.ok(added.message.startsWith('已记下 #'));
  const listed = await run({ action: 'list' });
  assert.equal(listed.ok, true);
  assert.ok(listed.message.includes('待复盘 1 项'));
  assert.ok(listed.message.includes('不确定的 事别说成确定的'));
  const id = /#([0-9a-f]{6})/.exec(added.message)![1]!;
  const done = await run({ action: 'done', key: id });
  assert.equal(done.ok, true);
  assert.ok(done.message.startsWith('已复盘'));
  assert.equal((await run({ action: 'list' })).message, '错题本里没有待复盘条目');
});

test('done moves the row out of corrections.md into corrections-done.md', async () => {
  const added = await run({ action: 'add', text: '一条已复盘的纠正' });
  const id = /#([0-9a-f]{6})/.exec(added.message)![1]!;
  const done = await run({ action: 'done', key: id });
  assert.equal(done.ok, true);
  const live = fs.readFileSync(file, 'utf8');
  assert.ok(!live.includes(`#${id}`));
  assert.ok(!live.includes('[done]'));
  const archive = readLedger(guard, correctionsDoneFilePath(workspace().dataDir)).entries;
  assert.equal(archive.length, 1);
  assert.equal(archive[0]!.status, 'done');
  assert.equal(archive[0]!.id, id);
});

test('the two books stay in separate files and never bleed into each other', async () => {
  await run({ action: 'add', text: '一条纠正' });
  const ledgerFile = ledgerFilePath(workspace().dataDir);
  appendEntry(guard, ledgerFile, '一条待办');
  assert.equal(scanPending(guard, file).length, 1);
  assert.equal(scanPending(guard, ledgerFile).length, 1);
  const ledgerRaw = fs.readFileSync(ledgerFile, 'utf8');
  assert.ok(ledgerRaw.startsWith('# 账本'));
  assert.ok(!ledgerRaw.includes('一条纠正'));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('一条待办'));
});

test('bad input fails soft with a message, never throws', async () => {
  const noText = await run({ action: 'add' });
  assert.equal(noText.ok, false);
  const miss = await run({ action: 'done', key: '不存在' });
  assert.equal(miss.ok, false);
  assert.ok(miss.message.includes('没有找到'));
  await assert.doesNotReject(() => run(null));
});

test('render projects the message as a text block', () => {
  const blocks = tool.output.render({}, { message: '你好' }) as { type: string; text: string }[];
  assert.deepEqual(blocks, [{ type: 'text', text: '你好' }]);
});
