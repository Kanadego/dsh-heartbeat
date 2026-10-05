import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import { ledgerFilePath } from '../src/ledger/ledger.js';
import { buildLedgerTool } from '../src/ledger/tool.js';

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;
let tool: ReturnType<() => Record<string, any>>;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-ltool-'));
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  guard = createPathGuard(workspace().dataDir);
  tool = buildLedgerTool(guard, ledgerFilePath(workspace().dataDir)) as Record<string, any>;
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
});

const run = async (args: unknown): Promise<{ ok: boolean; message: string }> =>
  (await tool.execute(args, {} as never)) as { ok: boolean; message: string };

test('definition carries the model-facing contract', () => {
  assert.equal(tool.name, 'ledger');
  assert.ok(String(tool.description).includes('主动'));
  const params = tool.parameters as { type: string; required: string[]; properties: Record<string, { enum?: string[] }> };
  assert.equal(params.type, 'object');
  assert.deepEqual(params.required, ['action']);
  assert.deepEqual(params.properties.action!.enum, ['add', 'list', 'done']);
  assert.equal(typeof tool.output.render, 'function');
  assert.equal(tool.isConcurrencySafe({}), false); // read-modify-write on one file
});

test('add → list → done roundtrip through the tool', async () => {
  const added = await run({ action: 'add', text: '  修好   排风  ' });
  assert.equal(added.ok, true);
  assert.ok(added.message.startsWith('已登记 #'));
  const listed = await run({ action: 'list' });
  assert.equal(listed.ok, true);
  assert.ok(listed.message.includes('修好 排风'));
  const id = /#([0-9a-f]{6})/.exec(added.message)![1]!;
  const done = await run({ action: 'done', key: id });
  assert.equal(done.ok, true);
  const empty = await run({ action: 'list' });
  assert.equal(empty.message, '账本里没有未完成事项');
});

test('done by unique substring; unknown key reports miss', async () => {
  await run({ action: 'add', text: '把设置卡配色换成浅色' });
  const done = await run({ action: 'done', key: '配色' });
  assert.equal(done.ok, true);
  const miss = await run({ action: 'done', key: '不存在的事' });
  assert.equal(miss.ok, false);
  assert.ok(miss.message.includes('没有找到'));
});

test('bad input fails soft with a message, never throws', async () => {
  const noText = await run({ action: 'add' });
  assert.equal(noText.ok, false);
  const badAction = await run({ action: 'explode' });
  assert.equal(badAction.ok, false);
  await assert.doesNotReject(() => run(null));
});

test('render projects the message as a text block', () => {
  const blocks = tool.output.render({}, { message: '你好' }) as { type: string; text: string }[];
  assert.deepEqual(blocks, [{ type: 'text', text: '你好' }]);
});
