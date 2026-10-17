import { sandboxDir } from './_sandbox.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import {
  EXCERPT_HEADER,
  appendExcerpt,
  excerptFilePath,
  readExcerpts,
  recentExcerpts,
  removeExcerpt,
} from '../src/excerpt/excerpt.js';
import { buildExcerptTool } from '../src/excerpt/tool.js';

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;
let file = '';

beforeEach(() => {
  sandbox = sandboxDir('hb-excerpt-');
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  guard = createPathGuard(workspace().dataDir);
  file = excerptFilePath(workspace().dataDir);
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
});

test('an empty workspace reads as an empty notebook, not an error', () => {
  const { entries, rawLines } = readExcerpts(guard, file);
  assert.equal(entries.length, 0);
  assert.deepEqual(rawLines, EXCERPT_HEADER.split('\n'));
  assert.equal(recentExcerpts(guard, file, 10).length, 0);
});

test('append stamps the local wall clock and keeps the header', () => {
  const e = appendExcerpt(guard, file, '  他说：认出我来了哦。  ', Date.parse('2026-10-16T01:30:00'));
  assert.equal(e.date, '2026-10-16');
  assert.equal(e.time, '01:30');
  assert.equal(e.text, '他说：认出我来了哦。');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(raw.startsWith('# 摘抄本'));
  assert.ok(raw.includes(`[#${e.id}] 他说：认出我来了哦。`));
  assert.equal(readExcerpts(guard, file).entries.length, 1);
});

test('the notebook is plaintext on disk (a notebook has to be readable)', () => {
  appendExcerpt(guard, file, '一句想留下来的话');
  const buf = fs.readFileSync(file);
  assert.notEqual(buf.subarray(0, 5).toString('utf8'), 'KHBV2');
  assert.ok(buf.toString('utf8').includes('一句想留下来的话'));
});

test('entries read back in the order they were written; recentExcerpts takes the tail', () => {
  for (let i = 1; i <= 4; i += 1) {
    appendExcerpt(guard, file, `第 ${i} 条`, Date.parse('2026-10-16T0' + i + ':00:00'));
  }
  assert.deepEqual(readExcerpts(guard, file).entries.map((e) => e.text), [
    '第 1 条', '第 2 条', '第 3 条', '第 4 条',
  ]);
  assert.deepEqual(recentExcerpts(guard, file, 2).map((e) => e.text), ['第 3 条', '第 4 条']);
  assert.deepEqual(recentExcerpts(guard, file, 0), []);
});

test('hand-written lines survive an append verbatim', () => {
  appendExcerpt(guard, file, '正常的一条');
  const raw = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, raw + '手写的一行：今天风很大\n', 'utf8');
  const e = appendExcerpt(guard, file, '追加的一条');
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.includes('手写的一行：今天风很大'));
  assert.ok(after.includes(e.id));
});

test('removeExcerpt tears a page out by id and by unique substring', () => {
  const a = appendExcerpt(guard, file, '第一条：留着', Date.parse('2026-10-16T01:00:00'));
  appendExcerpt(guard, file, '第二条：也留着', Date.parse('2026-10-16T02:00:00'));
  assert.ok(removeExcerpt(guard, file, a.id));
  assert.equal(readExcerpts(guard, file).entries.length, 1);
  assert.ok(removeExcerpt(guard, file, '也留着'));
  assert.equal(readExcerpts(guard, file).entries.length, 0);
  assert.equal(removeExcerpt(guard, file, '不存在的一句'), null);
});

test('removeExcerpt leaves hand-written lines alone', () => {
  const a = appendExcerpt(guard, file, '要抹掉的一条');
  const raw = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, raw + '手写备注\n', 'utf8');
  assert.ok(removeExcerpt(guard, file, a.id));
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.includes('手写备注'));
  assert.ok(!after.includes('要抹掉的一条'));
});

test('empty text is refused and multi-line text is collapsed to one line', () => {
  assert.throws(() => appendExcerpt(guard, file, '   '), /must not be empty/);
  const e = appendExcerpt(guard, file, '上半句\n下半句');
  assert.equal(e.text, '上半句 下半句');
});

const asTool = (): Record<string, any> => buildExcerptTool(guard, file) as Record<string, any>;
const run = async (args: unknown): Promise<{ ok: boolean; message: string }> =>
  (await asTool().execute(args, {} as never)) as { ok: boolean; message: string };

test('definition carries the model-facing contract', () => {
  const tool = asTool();
  assert.equal(tool.name, 'excerpt');
  const desc = String(tool.description);
  assert.ok(desc.includes('摘抄本'));
  assert.ok(desc.includes('账本')); // the boundary with the other two stores is spelled out
  assert.ok(desc.includes('心事匣'));
  const params = tool.parameters as { type: string; required: string[]; properties: Record<string, { enum?: string[] }> };
  assert.equal(params.type, 'object');
  assert.deepEqual(params.required, ['action']);
  assert.deepEqual(params.properties.action!.enum, ['add', 'list', 'remove']);
  assert.equal(typeof tool.output.render, 'function');
  assert.equal(tool.isConcurrencySafe({}), false);
});

test('render projects the message as a text block', () => {
  const blocks = asTool().output.render({}, { message: '你好' }) as { type: string; text: string }[];
  assert.deepEqual(blocks, [{ type: 'text', text: '你好' }]);
});

test('add → list → remove roundtrip through the tool', async () => {
  const added = await run({ action: 'add', text: '  「认出我来了哦。」  ' });
  assert.equal(added.ok, true);
  assert.ok(added.message.startsWith('已抄下 #'));
  const listed = await run({ action: 'list' });
  assert.equal(listed.ok, true);
  assert.ok(listed.message.includes('摘抄本共 1 条'));
  assert.ok(listed.message.includes('认出我来了哦'));
  const id = /#([0-9a-f]{6})/.exec(added.message)![1]!;
  assert.equal((await run({ action: 'remove', key: id })).ok, true);
  assert.equal((await run({ action: 'list' })).message, '摘抄本还是空的');
});

test('list shows the tail and the total, and remove reports a miss', async () => {
  for (let i = 1; i <= 12; i += 1) await run({ action: 'add', text: `第 ${i} 条` });
  const listed = await run({ action: 'list' });
  assert.ok(listed.message.includes('摘抄本共 12 条，最近 10 条'));
  assert.ok(listed.message.includes('第 12 条'));
  assert.ok(!listed.message.includes('第 1 条\n'));
  const miss = await run({ action: 'remove', key: '不存在的一句' });
  assert.equal(miss.ok, false);
  assert.ok(miss.message.includes('没有匹配'));
});

test('over-long text is truncated to the tool limit', async () => {
  const long = '啊'.repeat(400);
  const added = await run({ action: 'add', text: long });
  assert.equal(added.ok, true);
  assert.equal(readExcerpts(guard, file).entries[0]!.text.length, 300);
});

test('bad input fails soft with a message, never throws', async () => {
  assert.equal((await run({ action: 'add' })).ok, false);
  assert.equal((await run({ action: 'add', text: '   ' })).ok, false);
  assert.equal((await run({ action: 'remove' })).ok, false);
  assert.equal((await run({ action: 'explode' })).ok, false);
  await assert.doesNotReject(() => run(null));
  await assert.doesNotReject(() => run({}));
});
