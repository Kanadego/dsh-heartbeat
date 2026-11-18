// 2.3.0 P0-2: live-only books + archive. markDone must摘走 (row gone from the
// book, appended to the archive in the same line format); the first start must
// move legacy inline done rows exactly once (backup + marker + audit), with
// entries conserved.
import { sandboxDir } from './_sandbox.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import { loadPolicy } from '../src/config/load.js';
import type { Policy } from '../src/config/schema.js';
import { atomicCreateFileSync } from '../src/core/atomic-fs.js';
import { installHeartbeatRpc } from '../src/rpc.js';
import { main } from '../src/cli/index.js';
import {
  CORRECTIONS_DONE_HEADER,
  CORRECTIONS_HEADER,
  LEDGER_DONE_HEADER,
  LEDGER_HEADER,
  appendArchiveLines,
  correctionsDoneFilePath,
  correctionsFilePath,
  ledgerDoneFilePath,
  ledgerFilePath,
  markDone,
  readLedger,
  seedBookFile,
} from '../src/ledger/ledger.js';
import { bookSpecs, migrateBookDone, readState } from '../src/ledger/archive.js';
import { buildLedgerTool, buildCorrectionsTool } from '../src/ledger/tool.js';
import { apply } from '../src/index.js';

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;

beforeEach(() => {
  sandbox = sandboxDir('hb-archive-');
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  guard = createPathGuard(workspace().dataDir);
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
});

test('markDone removes the row from the book and appends it to the archive', () => {
  const dir = workspace().dataDir;
  const file = ledgerFilePath(dir);
  fs.writeFileSync(
    file,
    '# 账本\n- [2026-09-01 10:00][open][#aaa111] 旧事项\n- [2026-09-02 10:00][open][#bbb222] 新事项\n',
    'utf8',
  );
  assert.ok(markDone(guard, file, 'aaa111', Date.parse('2026-09-06T12:34:00')));
  const book = fs.readFileSync(file, 'utf8');
  assert.ok(!book.includes('#aaa111'));
  assert.ok(book.includes('#bbb222'));
  const archiveRaw = fs.readFileSync(ledgerDoneFilePath(dir), 'utf8');
  assert.ok(archiveRaw.startsWith(LEDGER_DONE_HEADER.split('\n')[0]!));
  assert.ok(archiveRaw.includes('- [2026-09-06 12:34][done][#aaa111] 旧事项'));
  // same parser, same format: the archive reads like any book file
  const { entries } = readLedger(guard, ledgerDoneFilePath(dir));
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.status, 'done');
  assert.equal(entries[0]!.id, 'aaa111');
});

test('archive append skips a line it already holds (crash-retry safety)', () => {
  const done = ledgerDoneFilePath(workspace().dataDir);
  const line = '- [2026-09-06 12:00][done][#aaa111] x';
  assert.equal(appendArchiveLines(guard, done, LEDGER_DONE_HEADER, [line]), 1);
  assert.equal(appendArchiveLines(guard, done, LEDGER_DONE_HEADER, [line]), 0);
  assert.equal(readLedger(guard, done).entries.length, 1);
});

test('archive dedupe ignores the restamped minute (cross-minute retry)', () => {
  const dir = workspace().dataDir;
  const file = ledgerFilePath(dir);
  const openRow = '- [2026-09-01 10:00][open][#aaa111] 旧事项\n';
  fs.writeFileSync(file, `# 账本\n${openRow}`, 'utf8');

  // Attempt 1 archives at 12:00; simulate a crash BEFORE the book rewrite.
  assert.ok(markDone(guard, file, 'aaa111', Date.parse('2026-09-06T12:00:00')));
  fs.writeFileSync(file, `# 账本\n${openRow}`, 'utf8');

  // Attempt 2 runs a minute later, so the raw done line differs by [time].
  assert.ok(markDone(guard, file, 'aaa111', Date.parse('2026-09-06T12:01:00')));
  const archive = readLedger(guard, ledgerDoneFilePath(dir)).entries;
  assert.equal(archive.length, 1);
  assert.equal(archive[0]!.id, 'aaa111');
  assert.equal(archive[0]!.status, 'done');
});

test('markDone removes only that entry: same-id other text and hand notes stay', () => {
  const file = ledgerFilePath(workspace().dataDir);
  fs.writeFileSync(
    file,
    '# 账本\n' +
      '- [2026-09-01 10:00][open][#abc123] 目标条目\n' +
      '- [2026-09-02 10:00][open][#abc123] 同号但另一条\n' +
      '手写备注：见 [#abc123] 那条，别动\n',
    'utf8',
  );
  assert.ok(markDone(guard, file, 'abc123'));
  const book = fs.readFileSync(file, 'utf8');
  assert.ok(!book.includes('目标条目'));
  assert.ok(book.includes('同号但另一条'));
  assert.ok(book.includes('手写备注：见 [#abc123] 那条，别动'));
  const archive = readLedger(guard, ledgerDoneFilePath(workspace().dataDir)).entries;
  assert.equal(archive.length, 1);
  assert.equal(archive[0]!.text, '目标条目');
});

test('same id+text completed again a month later archives a second row', () => {
  const dir = workspace().dataDir;
  const file = ledgerFilePath(dir);
  // Hand-written id rows are supported (tests/ledger.test.ts), so the same
  // wording can legitimately be completed again next month.
  const row = '- [2026-09-01 09:00][open][#nas-backup] 备份 NAS 到移动盘\n';
  fs.writeFileSync(file, `# 账本\n${row}`, 'utf8');
  assert.ok(markDone(guard, file, 'nas-backup', Date.parse('2026-09-05T09:00:00')));
  fs.writeFileSync(file, `# 账本\n${row}`, 'utf8');
  assert.ok(markDone(guard, file, 'nas-backup', Date.parse('2026-10-05T09:00:00')));

  const archive = readLedger(guard, ledgerDoneFilePath(dir)).entries;
  assert.equal(archive.length, 2);
  assert.deepEqual(archive.map((e) => e.date), ['2026-09-05', '2026-10-05']);
  assert.deepEqual(readLedger(guard, file).entries, []);
});

test('two byte-identical open rows: only one is extracted, the other stays open', () => {
  const dir = workspace().dataDir;
  const file = ledgerFilePath(dir);
  const row = '- [2026-09-01 10:00][open][#dup001] 重复行\n';
  fs.writeFileSync(file, `# 账本\n${row}${row}`, 'utf8');

  assert.ok(markDone(guard, file, 'dup001'));
  const left = readLedger(guard, file).entries;
  assert.equal(left.length, 1);
  assert.equal(left[0]!.status, 'open');
  assert.equal(left[0]!.id, 'dup001');
  assert.equal(readLedger(guard, ledgerDoneFilePath(dir)).entries.length, 1);
});

test('seedBookFile never overwrites an existing book or archive', () => {
  const file = ledgerDoneFilePath(workspace().dataDir);
  const existing = `${LEDGER_DONE_HEADER}- [2026-09-06 12:00][done][#aaa111] x\n`;
  fs.writeFileSync(file, existing, 'utf8');
  seedBookFile(guard, file, LEDGER_DONE_HEADER);
  assert.equal(fs.readFileSync(file, 'utf8'), existing);
  const fresh = ledgerFilePath(workspace().dataDir);
  seedBookFile(guard, fresh, '# 账本\n');
  assert.equal(fs.readFileSync(fresh, 'utf8'), '# 账本\n');
});

test('seedBookFile publishes the header atomically and leaves no temp siblings (N16④)', () => {
  const dir = workspace().dataDir;
  const fresh = ledgerFilePath(dir);
  seedBookFile(guard, fresh, '# 账本\n');
  assert.equal(fs.readFileSync(fresh, 'utf8'), '# 账本\n');
  // the atomic publication writes a temp sibling and hard-links it into place;
  // nothing may be left behind
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
});

test('atomicCreateFileSync refuses to replace a concurrently created file (N16④)', () => {
  const dir = workspace().dataDir;
  const target = path.join(dir, 'atomic-create-probe.md');
  fs.writeFileSync(target, 'someone else got here first\n', 'utf8');
  atomicCreateFileSync(target, 'seed\n');
  assert.equal(fs.readFileSync(target, 'utf8'), 'someone else got here first\n');
  const fresh = path.join(dir, 'atomic-create-fresh.md');
  atomicCreateFileSync(fresh, 'seed\n');
  assert.equal(fs.readFileSync(fresh, 'utf8'), 'seed\n');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
  fs.rmSync(fresh);
});

test('markDone audits a completion the archive dedupes away (N16① swallowed)', () => {
  const dir = workspace().dataDir;
  const file = ledgerFilePath(dir);
  fs.writeFileSync(file, '# 账本\n- [2026-09-01 10:00][open][#ab0001] 险被吞的完成\n', 'utf8');
  // the archive already holds the row markDone is about to produce (same
  // id+text+stamp): the row leaves the book but is not appended again
  fs.writeFileSync(
    ledgerDoneFilePath(dir),
    `${LEDGER_DONE_HEADER}- [2026-09-06 12:00][done][#ab0001] 险被吞的完成\n`,
    'utf8',
  );
  const audits: Record<string, unknown>[] = [];
  const target = markDone(
    guard, file, 'ab0001', Date.parse('2026-09-06T12:00:00'),
    undefined, undefined,
    (e) => audits.push(e),
  );
  assert.ok(target);
  assert.equal(readLedger(guard, file).entries.length, 0); // row still leaves the book
  assert.equal(readLedger(guard, ledgerDoneFilePath(dir)).entries.length, 1); // not doubled
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.event, 'book_done_deduped');
  assert.equal(audits[0]!.id, 'ab0001');
  assert.equal(audits[0]!.archive, 'ledger-done.md');
  assert.equal(audits[0]!.reason, 'same-stamp');
  // the audit log carries no raw observations — keep the row text out of it
  assert.ok(!JSON.stringify(audits[0]).includes('险被吞'));
});

test('markDone stays silent on the normal archiving path (N16①)', () => {
  const dir = workspace().dataDir;
  const file = ledgerFilePath(dir);
  fs.writeFileSync(file, '# 账本\n- [2026-09-01 10:00][open][#ok001] 正常完成\n', 'utf8');
  const audits: Record<string, unknown>[] = [];
  assert.ok(markDone(
    guard, file, 'ok001', Date.parse('2026-09-06T12:00:00'),
    undefined, undefined,
    (e) => audits.push(e),
  ));
  assert.equal(readLedger(guard, ledgerDoneFilePath(dir)).entries.length, 1);
  assert.deepEqual(audits, []);
});

test('the chat tool path audits a swallowed completion too (N16① tool wiring)', async () => {
  const dir = workspace().dataDir;
  const file = ledgerFilePath(dir);
  const openRow = '- [2026-09-01 10:00][open][#ab0002] 工具路径的完成\n';
  fs.writeFileSync(file, `# 账本\n${openRow}`, 'utf8');
  const audits: Record<string, unknown>[] = [];
  const tool = buildLedgerTool(guard, file, (e) => audits.push(e)) as {
    execute(a: unknown): Promise<{ ok: boolean; message: string }>;
  };

  const first = await tool.execute({ action: 'done', key: 'ab0002' });
  assert.equal(first.ok, true);
  assert.equal(readLedger(guard, ledgerDoneFilePath(dir)).entries.length, 1);
  assert.equal(audits.length, 0); // normal path: no swallow record

  // the row is re-opened by hand and the same item is checked off again
  // moments later — well inside the retry window, the archive dedupes it
  fs.writeFileSync(file, `# 账本\n${openRow}`, 'utf8');
  const second = await tool.execute({ action: 'done', key: 'ab0002' });
  assert.equal(second.ok, true); // markDone still returns the row
  assert.equal(readLedger(guard, file).entries.length, 0);
  assert.equal(readLedger(guard, ledgerDoneFilePath(dir)).entries.length, 1); // not doubled
  const deduped = audits.filter((e) => e.event === 'book_done_deduped');
  assert.deepEqual(deduped.map((e) => e.id), ['ab0002']);
  assert.ok(['same-stamp', 'retry-window'].includes(String(deduped.map((e) => e.reason)[0])), 'reason=' + deduped.map((e) => e.reason)[0]); // same wall minute → same-stamp, crossing a minute → retry-window
  // the audit carries no row text
  assert.ok(!JSON.stringify(audits).includes('工具路径的完成'));
});

test('a future-stamped archive row within a day is a retry (N16③, future grace)', () => {
  const dir = workspace().dataDir;
  const file = ledgerFilePath(dir);
  fs.writeFileSync(file, '# 账本\n- [2026-09-01 10:00][open][#f00001] 时钟回拨前的完成\n', 'utf8');
  // hand-edited / clock-skewed archive row stamped AFTER now: Math.abs judged
  // it "far from now" and double-archived; the single-sided window must not
  fs.writeFileSync(
    ledgerDoneFilePath(dir),
    `${LEDGER_DONE_HEADER}- [2026-09-07 00:00][done][#f00001] 时钟回拨前的完成\n`,
    'utf8',
  );
  const audits: Record<string, unknown>[] = [];
  assert.ok(markDone(
    guard, file, 'f00001', Date.parse('2026-09-06T12:00:00'),
    undefined, undefined,
    (e) => audits.push(e),
  ));
  const archive = readLedger(guard, ledgerDoneFilePath(dir)).entries;
  assert.equal(archive.length, 1);
  assert.equal(archive[0]!.date, '2026-09-07');
  assert.equal(readLedger(guard, file).entries.length, 0);
  // and the dedupe is auditable (N16①)
  assert.deepEqual(audits.map((e) => e.event), ['book_done_deduped']);
  assert.deepEqual(audits.map((e) => e.reason), ['future-stamp']);
});

test('a far-future stamp self-heals: the next real completion archives (N16④)', () => {
  const dir = workspace().dataDir;
  const file = ledgerFilePath(dir);
  // one year-2099 stamp must not swallow real completions forever
  fs.writeFileSync(
    ledgerDoneFilePath(dir),
    `${LEDGER_DONE_HEADER}- [2099-01-01 00:00][done][#f00002] 未来年的完成\n`,
    'utf8',
  );
  fs.writeFileSync(file, '# 账本\n- [2026-09-01 10:00][open][#f00002] 未来年的完成\n', 'utf8');
  const audits: Record<string, unknown>[] = [];
  assert.ok(markDone(
    guard, file, 'f00002', Date.parse('2026-09-06T12:00:00'),
    undefined, undefined,
    (e) => audits.push(e),
  ));
  const archive = readLedger(guard, ledgerDoneFilePath(dir)).entries;
  assert.equal(archive.length, 2); // the real completion IS archived
  assert.deepEqual(archive.map((e) => e.date), ['2099-01-01', '2026-09-06']);
  assert.equal(readLedger(guard, file).entries.length, 0);
  assert.equal(audits.length, 0); // nothing was deduped — nothing to audit
});

test('a wall gap of 70 minutes across a DST shift is still a retry (N16② extended window)', () => {
  const dir = workspace().dataDir;
  const done = ledgerDoneFilePath(dir);
  // spring-forward: the retry runs ten REAL minutes after 01:55 but renders
  // 03:05 — the old epoch math deduped it, the component form needs the grace
  const line1 = '- [2026-03-08 01:55][done][#d00001] 夏令时重试\n';
  const line2 = '- [2026-03-08 03:05][done][#d00001] 夏令时重试'; // no trailing \n: a parseable row, not a verbatim note
  fs.writeFileSync(done, `${LEDGER_DONE_HEADER}${line1}\n`, 'utf8');
  const reasons: string[] = [];
  // `now` renders to the 03:05 wall clock in the test process's own zone
  const now = Date.parse('2026-03-08T03:05:00');
  const appended = appendArchiveLines(guard, done, LEDGER_DONE_HEADER, [line2], now, (info) => reasons.push(info.reason));
  assert.equal(appended, 0); // not double-archived
  assert.deepEqual(reasons, ['retry-window-extended']);
  assert.equal(readLedger(guard, done).entries.length, 1);
});

test('a hand-written non-hex id is audited without the id (privacy, N16①)', () => {
  const dir = workspace().dataDir;
  const file = ledgerFilePath(dir);
  fs.writeFileSync(file, '# 账本\n- [2026-09-01 10:00][open][#家人的生日] 手写中文 id\n', 'utf8');
  fs.writeFileSync(
    ledgerDoneFilePath(dir),
    `${LEDGER_DONE_HEADER}- [2026-09-06 12:00][done][#家人的生日] 手写中文 id\n`,
    'utf8',
  );
  const audits: Record<string, unknown>[] = [];
  assert.ok(markDone(
    guard, file, '家人的生日', Date.parse('2026-09-06T12:00:00'),
    undefined, undefined,
    (e) => audits.push(e),
  ));
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.event, 'book_done_deduped');
  assert.equal('id' in audits[0]!, false); // the personal id stays out
  assert.equal(audits[0]!.archive, 'ledger-done.md'); // but the row stays locatable
});

const WORKER_SRC = `
const [dataDir, ledgerUrl, guardUrl, pathsUrl, ...ids] = process.argv.slice(2);
process.env.HEARTBEAT_DATA_DIR = dataDir;
const { initWorkspace } = await import(pathsUrl);
initWorkspace();
const { createPathGuard } = await import(guardUrl);
const { markDone, ledgerFilePath } = await import(ledgerUrl);
const guard = createPathGuard(dataDir);
const file = ledgerFilePath(dataDir);
for (const id of ids) {
  if (!markDone(guard, file, id)) {
    console.error('row not found: ' + id);
    process.exit(2);
  }
}
`;

function runWorker(worker: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', worker, ...args], {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      ...(env ? { env } : {}),
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

// H-20: the book and archive are whole-file rewrites and the CLI is a second
// process. Without a lock, four interleaved read→mutate→write cycles drop
// archive rows and resurrect book rows that another process just removed.
// A 2k-row archive seed widens the window so the race is actually exercised.
test('concurrent processes mark rows done: no lost completions, no revived rows', async () => {
  const dir = workspace().dataDir;
  const file = ledgerFilePath(dir);
  const seedCount = 2000;
  const seed = Array.from(
    { length: seedCount },
    (_, i) => `- [2026-01-01 00:00][done][#s${String(i).padStart(5, '0')}] seed ${i}`,
  );
  fs.writeFileSync(ledgerDoneFilePath(dir), `${LEDGER_DONE_HEADER}${seed.join('\n')}\n`, 'utf8');

  const ids = Array.from({ length: 32 }, (_, i) => `c${String(i).padStart(5, '0')}`);
  fs.writeFileSync(
    file,
    `# 账本\n${ids.map((id) => `- [2026-09-01 10:00][open][#${id}] row ${id}`).join('\n')}\n`,
    'utf8',
  );

  const worker = path.join(sandbox, 'archive-worker.mjs');
  fs.writeFileSync(worker, WORKER_SRC, 'utf8');
  const ledgerUrl = new URL('../src/ledger/ledger.ts', import.meta.url).href;
  const guardUrl = new URL('../src/core/path-guard.ts', import.meta.url).href;
  const pathsUrl = new URL('../src/core/paths.ts', import.meta.url).href;
  const projectRoot = fileURLToPath(new URL('..', import.meta.url));

  const groups = 4;
  await Promise.all(
    Array.from({ length: groups }, (_, g) =>
      runWorker(worker, [dir, ledgerUrl, guardUrl, pathsUrl, ...ids.filter((_, i) => i % groups === g)], projectRoot),
    ),
  );

  assert.deepEqual(readLedger(guard, file).entries, []);
  const archive = readLedger(guard, ledgerDoneFilePath(dir)).entries;
  assert.equal(archive.length, seedCount + ids.length);
  assert.equal(new Set(archive.map((e) => e.id)).size, seedCount + ids.length);
  for (const id of ids) {
    assert.equal(archive.filter((e) => e.id === id).length, 1, `completion ${id} archived exactly once`);
  }
});

// N16②: the stamp is wall-clock text, so its epoch depends on the timezone of
// whoever parses it. The archive row below was stamped under +08:00; a retry
// process running under UTC restamps the completion to the UTC wall clock and
// the old Date.parse arithmetic measured the archived stamp in the retry zone,
// double-archiving (observed: +08:00 archive, UTC retry duplicates). Wall-
// component arithmetic must dedupe it — hence a REAL UTC child process.
const TZ_WORKER_SRC = `
const [dataDir, ledgerUrl, guardUrl, pathsUrl] = process.argv.slice(2);
process.env.HEARTBEAT_DATA_DIR = dataDir;
if (process.env.TZ !== 'UTC' || new Date().getTimezoneOffset() !== 0) {
  console.error('worker must run under UTC');
  process.exit(3);
}
const { initWorkspace } = await import(pathsUrl);
initWorkspace();
const { createPathGuard } = await import(guardUrl);
const { markDone, ledgerFilePath } = await import(ledgerUrl);
const guard = createPathGuard(dataDir);
const file = ledgerFilePath(dataDir);
if (!markDone(guard, file, 'tz001', Date.parse('2026-09-06T04:05:00Z'))) {
  console.error('row not found: tz001');
  process.exit(2);
}
`;

test('completion dedupe survives a timezone change between archive and retry (N16②)', async () => {
  const dir = workspace().dataDir;
  const file = ledgerFilePath(dir);
  // stamped under +08:00 wall clock (12:00 local ≈ 04:00Z true instant)
  fs.writeFileSync(
    ledgerDoneFilePath(dir),
    `${LEDGER_DONE_HEADER}- [2026-09-06 12:00][done][#tz001] 跨时区回归\n`,
    'utf8',
  );
  fs.writeFileSync(file, '# 账本\n- [2026-09-01 10:00][open][#tz001] 跨时区回归\n', 'utf8');

  const worker = path.join(sandbox, 'tz-worker.mjs');
  fs.writeFileSync(worker, TZ_WORKER_SRC, 'utf8');
  const ledgerUrl = new URL('../src/ledger/ledger.ts', import.meta.url).href;
  const guardUrl = new URL('../src/core/path-guard.ts', import.meta.url).href;
  const pathsUrl = new URL('../src/core/paths.ts', import.meta.url).href;
  const projectRoot = fileURLToPath(new URL('..', import.meta.url));
  await runWorker(worker, [dir, ledgerUrl, guardUrl, pathsUrl], projectRoot, { ...process.env, TZ: 'UTC' });

  // the UTC retry (restamped 04:05) was recognised as the same completion:
  // exactly one archive row, the original +08:00 stamp, book emptied
  const archive = readLedger(guard, ledgerDoneFilePath(dir)).entries;
  assert.equal(archive.length, 1);
  assert.equal(archive[0]!.date, '2026-09-06');
  assert.equal(archive[0]!.time, '12:00');
  assert.deepEqual(readLedger(guard, file).entries, []);
});

test('first-start migration backs up, archives, marks state and audits the count', () => {
  const dir = workspace().dataDir;
  const file = ledgerFilePath(dir);
  const legacy =
    '# 账本\n' +
    '- [2026-08-01 09:00][done][#aaa111] 已完成甲\n' +
    '这是用户手写的一行备注，格式随意\n' +
    '- [2026-08-02 09:10][open][#bbb222] 未完成乙\n' +
    '- [2026-08-03 09:20][done][#ccc333] 已完成丙\n';
  fs.writeFileSync(file, legacy, 'utf8');

  const events: Record<string, unknown>[] = [];
  const spec = bookSpecs(dir)[0]!;
  const now = Date.parse('2026-11-17T14:00:00');
  const res = migrateBookDone(guard, spec, workspace().settingsDir, (e) => events.push(e), now);

  assert.equal(res.skipped, false);
  assert.equal(res.count, 2);
  assert.ok(res.backup);
  assert.equal(fs.readFileSync(res.backup!, 'utf8'), legacy); // byte-for-byte backup

  const bookRaw = fs.readFileSync(file, 'utf8');
  assert.ok(!bookRaw.includes('[done]'));
  assert.ok(bookRaw.includes('这是用户手写的一行备注，格式随意'));
  assert.ok(bookRaw.includes('#bbb222'));

  const archive = readLedger(guard, ledgerDoneFilePath(dir)).entries;
  assert.equal(archive.length, 2);
  assert.deepEqual(archive.map((e) => e.id), ['aaa111', 'ccc333']);

  // entries conserved: book + archive still holds the same three rows
  assert.equal(readLedger(guard, file).entries.length + archive.length, 3);

  assert.equal(readState(guard, workspace().settingsDir).ledgerDoneMigrated, true);
  assert.deepEqual(events.map((e) => [e.event, e.count]), [['ledger_done_migrated', 2]]);

  // second start: marker makes it a no-op, nothing re-audited, nothing moved
  const again = migrateBookDone(guard, spec, workspace().settingsDir, (e) => events.push(e), now + 1000);
  assert.equal(again.skipped, true);
  assert.equal(again.count, 0);
  assert.equal(events.length, 1);
  assert.equal(readLedger(guard, file).entries.length, 1);
  assert.equal(readLedger(guard, ledgerDoneFilePath(dir)).entries.length, 2);
});

test('corrections book migrates under its own marker and archive', () => {
  const dir = workspace().dataDir;
  const file = correctionsFilePath(dir);
  fs.writeFileSync(
    file,
    '# 错题本\n- [2026-08-01 09:00][done][#aaa111] 旧错\n- [2026-08-02 09:00][open][#bbb222] 待复盘\n',
    'utf8',
  );
  const events: Record<string, unknown>[] = [];
  const res = migrateBookDone(guard, bookSpecs(dir)[1]!, workspace().settingsDir, (e) => events.push(e), Date.now());

  assert.equal(res.count, 1);
  assert.ok(res.backup);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('[done]'));
  assert.equal(readLedger(guard, correctionsDoneFilePath(dir)).entries.length, 1);
  assert.equal(readState(guard, workspace().settingsDir).correctionsDoneMigrated, true);
  assert.deepEqual(events.map((e) => [e.event, e.count]), [['corrections_done_migrated', 1]]);
});

test('a missing book still gets its marker, without inventing a backup', () => {
  const dir = workspace().dataDir;
  const res = migrateBookDone(guard, bookSpecs(dir)[0]!, workspace().settingsDir, () => {}, Date.now());
  assert.equal(res.skipped, false);
  assert.equal(res.count, 0);
  assert.equal(res.backup, null);
  assert.equal(fs.existsSync(ledgerDoneFilePath(dir)), false);
  assert.equal(readState(guard, workspace().settingsDir).ledgerDoneMigrated, true);
});

test('crash-replay migration audits what it actually appended, not what it found (N16⑤)', () => {
  const dir = workspace().dataDir;
  const file = ledgerFilePath(dir);
  const done1 = '- [2026-08-01 09:00][done][#aaa111] 已完成甲';
  const done2 = '- [2026-08-03 09:20][done][#ccc333] 已完成丙';
  fs.writeFileSync(file, `# 账本\n${done1}\n${done2}\n- [2026-08-02 09:10][open][#bbb222] 未完成乙\n`, 'utf8');
  // crash between "append" and "rewrite": the archive already holds both rows
  fs.writeFileSync(ledgerDoneFilePath(dir), `${LEDGER_DONE_HEADER}${done1}\n${done2}\n`, 'utf8');

  const events: Record<string, unknown>[] = [];
  const res = migrateBookDone(guard, bookSpecs(dir)[0]!, workspace().settingsDir, (e) => events.push(e), Date.parse('2026-11-17T14:00:00'));
  assert.equal(res.skipped, false);
  assert.equal(res.count, 0); // appended: nothing — the old code reported 2
  assert.deepEqual(events.map((e) => [e.event, e.count]), [['ledger_done_migrated', 0]]);
  // the audit also records what the book HELD, so a 0-of-2 run is readable
  assert.equal(events[0]!.found, 2);
  // conservation: the book is still rewritten, the archive is not doubled
  assert.ok(!fs.readFileSync(file, 'utf8').includes('[done]'));
  assert.equal(readLedger(guard, ledgerDoneFilePath(dir)).entries.length, 2);
});

// ── N16⑥: endpoint-level cover for the seedBookFile call sites ─────────
// openPath would really launch the platform opener during the test; a bogus
// platform name selects the xdg-open fallback whose ENOENT is swallowed by
// design (src/core/open-path.ts), so the endpoints run window-free.

function withBogusPlatform<T>(fn: () => T): T {
  const real = process.platform;
  Object.defineProperty(process, 'platform', { value: 'zos' });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: real });
  }
}

interface RpcRoute {
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

/** Same fake host contract as tests/rpc.test.ts — only the open endpoints are
 *  exercised here, so the ui stub stays minimal. */
function installRpcHarness(): RpcRoute {
  const policy: Policy = loadPolicy(guard, workspace().configDir, workspace().settingsDir);
  let captured: RpcRoute | undefined;
  const scoped = {
    connection: {
      admit() { /* host gate */ },
      fetch: { register(r: RpcRoute) { captured = r; return () => { /* dispose */ }; } },
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
    { paths: workspace(), guard, policy, ui: { get: () => ({}), set: () => {} } } as never,
  );
  assert.ok(captured, 'the route must be registered during install');
  return captured;
}

async function rpcResult(route: RpcRoute, endpoint: string): Promise<RpcResult> {
  const res = await route.fetch(new Request('http://127.0.0.1/api/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', payload: { endpoint } }),
  }));
  assert.equal(res.status, 200);
  const body = await res.json() as { type: string; rpcId: string; result: RpcResult };
  assert.equal(body.type, 'server-response');
  return body.result;
}

test('rpc ledger.openDone keeps an existing archive intact and reports ok (N16⑥)', async () => {
  const dir = workspace().dataDir;
  const done = ledgerDoneFilePath(dir);
  const existing = `${LEDGER_DONE_HEADER}- [2026-09-06 12:00][done][#aaa111] x\n`;
  fs.writeFileSync(done, existing, 'utf8');

  const route = installRpcHarness();
  // openPath runs synchronously inside the handler; keep the bogus platform on
  // for the whole request round-trip
  let result: RpcResult;
  const real = process.platform;
  Object.defineProperty(process, 'platform', { value: 'zos' });
  try {
    result = await rpcResult(route, 'ledger.openDone');
  } finally {
    Object.defineProperty(process, 'platform', { value: real });
  }
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(done, 'utf8'), existing);
});

test('cli `ledger open --done` keeps an existing archive intact (N16⑥)', async () => {
  const dir = workspace().dataDir;
  const done = ledgerDoneFilePath(dir);
  const existing = `${LEDGER_DONE_HEADER}- [2026-09-06 12:00][done][#aaa111] x\n`;
  fs.writeFileSync(done, existing, 'utf8');

  const code = await withBogusPlatform(() => main(['ledger', 'open', '--done']));
  assert.equal(code, 0);
  assert.equal(fs.readFileSync(done, 'utf8'), existing);
});

// ── N16① cross-review: the audit wiring must be PINNED — removing the sink
// from any call site has to turn at least one of these red. ──────────────

function readDedupeAudit(): Record<string, unknown>[] {
  const logPath = path.join(workspace().logsDir, 'heartbeat.jsonl');
  assert.ok(fs.existsSync(logPath), 'the audit sink must have written logs/heartbeat.jsonl');
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.event === 'book_done_deduped');
}

test('cli `ledger done` writes the dedupe audit to heartbeat.jsonl (N16① wiring)', async () => {
  const dir = workspace().dataDir;
  const file = ledgerFilePath(dir);
  const openRow = '- [2026-09-01 10:00][open][#a00001] 接线钉子\n';
  fs.writeFileSync(file, `# 账本\n${openRow}`, 'utf8');

  assert.equal(await main(['ledger', 'done', 'a00001']), 0); // archives
  fs.writeFileSync(file, `# 账本\n${openRow}`, 'utf8'); // hand re-open
  assert.equal(await main(['ledger', 'done', 'a00001']), 0); // deduped ms later

  const deduped = readDedupeAudit();
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]!.id, 'a00001');
  assert.ok(['same-stamp', 'retry-window'].includes(String(deduped[0]!.reason)), 'reason=' + deduped[0]!.reason); // same wall minute → same-stamp, crossing a minute → retry-window
});

test('cli `corrections done` writes the dedupe audit to heartbeat.jsonl (N16① wiring)', async () => {
  const dir = workspace().dataDir;
  const file = correctionsFilePath(dir);
  const openRow = '- [2026-09-01 10:00][open][#a00002] 错题接线钉子\n';
  fs.writeFileSync(file, `# 错题本\n${openRow}`, 'utf8');

  assert.equal(await main(['corrections', 'done', 'a00002']), 0); // archives
  fs.writeFileSync(file, `# 错题本\n${openRow}`, 'utf8'); // hand re-open
  assert.equal(await main(['corrections', 'done', 'a00002']), 0); // deduped ms later

  const deduped = readDedupeAudit();
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]!.id, 'a00002');
  assert.equal(deduped[0]!.archive, 'corrections-done.md');
  assert.ok(['same-stamp', 'retry-window'].includes(String(deduped[0]!.reason)), 'reason=' + deduped[0]!.reason); // same wall minute → same-stamp, crossing a minute → retry-window
});

test('the corrections tool path audits a deduped completion too (N16① wiring)', async () => {
  const dir = workspace().dataDir;
  const file = correctionsFilePath(dir);
  const openRow = '- [2026-09-01 10:00][open][#a00003] 工具错题钉子\n';
  fs.writeFileSync(file, `# 错题本\n${openRow}`, 'utf8');
  const audits: Record<string, unknown>[] = [];
  const tool = buildCorrectionsTool(guard, file, (e) => audits.push(e)) as {
    execute(a: unknown): Promise<{ ok: boolean; message: string }>;
  };

  assert.equal((await tool.execute({ action: 'done', key: 'a00003' })).ok, true);
  fs.writeFileSync(file, `# 错题本\n${openRow}`, 'utf8');
  assert.equal((await tool.execute({ action: 'done', key: 'a00003' })).ok, true);

  assert.equal(readLedger(guard, correctionsDoneFilePath(dir)).entries.length, 1); // not doubled
  const deduped = audits.filter((e) => e.event === 'book_done_deduped');
  assert.deepEqual(deduped.map((e) => e.id), ['a00003']);
  assert.ok(['same-stamp', 'retry-window'].includes(String(deduped.map((e) => e.reason)[0])), 'reason=' + deduped.map((e) => e.reason)[0]); // same wall minute → same-stamp, crossing a minute → retry-window
});

test('atomicCreateFileSync falls back to wx when hard links are unsupported', async (t) => {
  const dir = workspace().dataDir;
  const fresh = path.join(dir, 'link-unsupported.md');
  const existing = path.join(dir, 'link-unsupported-existing.md');
  fs.writeFileSync(existing, 'keep me\n', 'utf8');
  // exFAT/FAT32/SMB reject hard links with EPERM/ENOTSUP/EACCES — seeding
  // must degrade to the direct exclusive create, not fail (N16② review 二)
  t.mock.method(fs, 'linkSync', () => {
    throw Object.assign(new Error('function not implemented'), { code: 'ENOTSUP' });
  });

  seedBookFile(guard, fresh, '# 账本\n');
  assert.equal(fs.readFileSync(fresh, 'utf8'), '# 账本\n');
  seedBookFile(guard, existing, '# 账本\n'); // EEXIST inside the fallback
  assert.equal(fs.readFileSync(existing, 'utf8'), 'keep me\n');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
});

// ── attempt-4 rework (N16② review 七条) ─────────────────────────────────

// 中2: the 10–70 wall-minute window is a DESIGNED tradeoff, not an accident:
// a real second completion of the same id+text inside it is swallowed — the
// archive keeps one row, the weekly report (which counts archive rows)
// under-counts by one, and the dedupe audit is the only trace.
test('a real second completion 30 wall minutes later is swallowed by the extended window (N16②, by design)', () => {
  const dir = workspace().dataDir;
  const done = ledgerDoneFilePath(dir);
  const file = ledgerFilePath(dir);
  fs.writeFileSync(done, `${LEDGER_DONE_HEADER}- [2026-09-06 11:30][done][#ab0005] 半小时后的真实重做\n`, 'utf8');
  fs.writeFileSync(file, '# 账本\n- [2026-09-01 10:00][open][#ab0005] 半小时后的真实重做\n', 'utf8');
  const audits: Record<string, unknown>[] = [];
  assert.ok(markDone(
    guard, file, 'ab0005', Date.parse('2026-09-06T12:00:00'),
    undefined, undefined,
    (e) => audits.push(e),
  ));
  const archive = readLedger(guard, done).entries;
  assert.equal(archive.length, 1); // not double-archived — the window wins
  assert.equal(archive[0]!.time, '11:30'); // the ORIGINAL row's stamp
  assert.deepEqual(audits.map((e) => e.event), ['book_done_deduped']);
  assert.deepEqual(audits.map((e) => e.reason), ['retry-window-extended']);
  // 低4: the audit locates the swallowed row by the ARCHIVE row's own stamp —
  // the done stamp (12:00) is this retry's fresh minute, useless for lookup
  assert.deepEqual([audits[0]!.rowDate, audits[0]!.rowTime], ['2026-09-06', '11:30']);
});

// 低1: the audit fires only after the book rewrite SUCCEEDED. The archive
// already holds the row (the dedupe hits), so the read-only book makes the
// rewrite throw AFTER a swallowed completion was detected: nothing may be
// audited (the rewrite failed — the row never left the book, nothing was
// swallowed, and every crash retry would re-log a phantom dedupe).
test('a failed book rewrite audits nothing and keeps the row (N16② audit order)', () => {
  const dir = workspace().dataDir;
  const file = ledgerFilePath(dir);
  const raw = '# 账本\n- [2026-09-01 10:00][open][#ab0006] 顺序钉子\n';
  fs.writeFileSync(file, raw, 'utf8');
  // the archive already holds exactly what markDone is about to produce: the
  // append dedupes, so a swallow IS detected before the book rewrite throws
  fs.writeFileSync(
    ledgerDoneFilePath(dir),
    `${LEDGER_DONE_HEADER}- [2026-09-06 12:00][done][#ab0006] 顺序钉子\n`,
    'utf8',
  );
  fs.chmodSync(file, 0o444); // the rename over the book now fails (Windows EPERM)
  const audits: Record<string, unknown>[] = [];
  try {
    assert.throws(() =>
      markDone(guard, file, 'ab0006', Date.parse('2026-09-06T12:00:00'), undefined, undefined, (e) => audits.push(e)),
    );
  } finally {
    fs.chmodSync(file, 0o644); // let the sandbox cleanup remove the file
  }
  assert.deepEqual(audits, []); // no audit before the rewrite succeeded
  assert.equal(fs.readFileSync(file, 'utf8'), raw); // the row never left the book
});

const EAST_TZ_WORKER_SRC = `
const [dataDir, ledgerUrl, guardUrl, pathsUrl] = process.argv.slice(2);
process.env.HEARTBEAT_DATA_DIR = dataDir;
if (process.env.TZ !== 'Asia/Shanghai' || new Date().getTimezoneOffset() !== -480) {
  console.error('worker must run under Asia/Shanghai (+08:00)');
  process.exit(3);
}
const { initWorkspace } = await import(pathsUrl);
initWorkspace();
const { createPathGuard } = await import(guardUrl);
const { markDone, ledgerFilePath } = await import(ledgerUrl);
const guard = createPathGuard(dataDir);
const file = ledgerFilePath(dataDir);
if (!markDone(guard, file, 'tz0002', Date.parse('2026-09-06T12:05:00Z'))) {
  console.error('row not found: tz0002');
  process.exit(2);
}
`;

// 低2: the window is single-sided BY DESIGN (see ledger.ts). A timezone move
// WESTWARD re-reads a fresh stamp as before-`now` (future-stamp covers it); an
// EASTWARD move renders `now` hours AHEAD of the archived wall stamp —
// indistinguishable from a real completion hours later — so the same
// completion may archive twice and the weekly report may over-count by one.
// This test PINS that documented limitation on purpose: it must turn red the
// day the window goes symmetric.
test('known limitation: a timezone move EASTWARD archives the same completion twice (N16②)', async () => {
  const dir = workspace().dataDir;
  const file = ledgerFilePath(dir);
  // the archive row was stamped under UTC wall clock (12:00)
  fs.writeFileSync(
    ledgerDoneFilePath(dir),
    `${LEDGER_DONE_HEADER}- [2026-09-06 12:00][done][#tz0002] 向东时区重试\n`,
    'utf8',
  );
  fs.writeFileSync(file, '# 账本\n- [2026-09-01 10:00][open][#tz0002] 向东时区重试\n', 'utf8');

  const worker = path.join(sandbox, 'tz-east-worker.mjs');
  fs.writeFileSync(worker, EAST_TZ_WORKER_SRC, 'utf8');
  const ledgerUrl = new URL('../src/ledger/ledger.ts', import.meta.url).href;
  const guardUrl = new URL('../src/core/path-guard.ts', import.meta.url).href;
  const pathsUrl = new URL('../src/core/paths.ts', import.meta.url).href;
  const projectRoot = fileURLToPath(new URL('..', import.meta.url));
  await runWorker(worker, [dir, ledgerUrl, guardUrl, pathsUrl], projectRoot, { ...process.env, TZ: 'Asia/Shanghai' });

  // the +08 retry restamps 12:05Z to 20:05 wall — 8h01m past the archived
  // stamp, beyond every window: a second row lands (the documented over-count)
  const archive = readLedger(guard, ledgerDoneFilePath(dir)).entries;
  assert.equal(archive.length, 2);
  assert.deepEqual(archive.map((e) => e.time), ['12:00', '20:05']);
  assert.deepEqual(readLedger(guard, file).entries, []);
});

// 低3: a failed write inside the link-free fallback must remove the stub it
// created — a half-written target would make every later exclusive create hit
// EEXIST forever. (The openSync('wx') failure path must NOT remove anything:
// EEXIST there is the first-creator-wins contract, another writer's file.)
test('exclusiveWriteDirectSync removes a half-written target before rethrowing (N16② review 低3)', async (t) => {
  const dir = workspace().dataDir;
  const target = path.join(dir, 'enospc-seed.md');
  const realWrite = fs.writeFileSync.bind(fs);
  let wroteTemp = false;
  t.mock.method(fs, 'linkSync', () => {
    throw Object.assign(new Error('links unavailable'), { code: 'EPERM' }); // force the fallback
  });
  t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
    // call 1 writes the temp sibling; call 2 is the direct exclusive create
    if (wroteTemp) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    wroteTemp = true;
    return realWrite(...args);
  });

  assert.throws(() => seedBookFile(guard, target, '# 账本\n'), { code: 'ENOSPC' });
  assert.equal(fs.existsSync(target), false, 'the half-written stub must not survive');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
});

// 低5: every seedBookFile call site must actually seed a MISSING file — the
// earlier endpoint tests only proved an existing archive is not overwritten.
test('rpc open endpoints seed the header when the file is missing (N16⑥)', async () => {
  const dir = workspace().dataDir;
  const route = installRpcHarness();
  const cases = [
    ['ledger.open', ledgerFilePath(dir), LEDGER_HEADER],
    ['ledger.openDone', ledgerDoneFilePath(dir), LEDGER_DONE_HEADER],
    ['corrections.open', correctionsFilePath(dir), CORRECTIONS_HEADER],
    ['corrections.openDone', correctionsDoneFilePath(dir), CORRECTIONS_DONE_HEADER],
  ] as const;
  for (const [endpoint, file, header] of cases) {
    assert.equal(fs.existsSync(file), false, `${endpoint}: expected a missing file`);
    let result: RpcResult;
    const real = process.platform;
    Object.defineProperty(process, 'platform', { value: 'zos' });
    try {
      result = await rpcResult(route, endpoint);
    } finally {
      Object.defineProperty(process, 'platform', { value: real });
    }
    assert.equal(result.ok, true, `${endpoint}: the endpoint must report ok`);
    assert.ok(
      fs.readFileSync(file, 'utf8').startsWith(header.split('\n')[0]!),
      `${endpoint}: header on disk after the request`,
    );
  }
});

test('cli `open --done` seeds the header when the archive is missing (N16⑥)', async () => {
  const dir = workspace().dataDir;
  assert.equal(await withBogusPlatform(() => main(['ledger', 'open', '--done'])), 0);
  assert.ok(
    fs.readFileSync(ledgerDoneFilePath(dir), 'utf8').startsWith(LEDGER_DONE_HEADER.split('\n')[0]!),
    'ledger open --done seeds the archive header',
  );
  assert.equal(await withBogusPlatform(() => main(['corrections', 'open', '--done'])), 0);
  assert.ok(
    fs.readFileSync(correctionsDoneFilePath(dir), 'utf8').startsWith(CORRECTIONS_DONE_HEADER.split('\n')[0]!),
    'corrections open --done seeds the archive header',
  );
});

// 中1: the PRODUCTION chat-tool wiring must be pinned behaviourally — removing
// either auditBookLine argument at src/index.ts has to turn this red. The
// plugin-inject.test.ts precedent (source-shape over apply()) exists because a
// full apply() needs the whole host; this test emulates just enough host to
// reach the global tool registration, then lets apply() die at the scheduler
// banner (the fake logger throws) so no 15s beat timer is ever armed.
test('apply() wires both chat books to the heartbeat audit log (N16① production wiring)', async () => {
  const dir = workspace().dataDir;
  const ledgerRow = '- [2026-09-01 10:00][open][#ab0004] 生产接线钉子\n';
  const correctionsRow = '- [2026-09-01 10:00][open][#a00004] 生产错题钉子\n';
  fs.writeFileSync(ledgerFilePath(dir), `# 账本\n${ledgerRow}`, 'utf8');
  fs.writeFileSync(correctionsFilePath(dir), `# 错题本\n${correctionsRow}`, 'utf8');

  const injected: Array<{ services: string[]; callback: (scoped: unknown) => void }> = [];
  const ctx = {
    logger: {
      // the orchestrator banner is the first logger call OUTSIDE the lazy
      // inject callbacks: by then both books are already registered, and the
      // throw stops apply() before any beat timer is armed
      info() { throw new Error('stop the scheduler: no beat timer in tests'); },
      warn() { /* quiet */ },
      error() { /* quiet */ },
    },
    inject(services: string[], callback: (scoped: unknown) => void) {
      injected.push({ services, callback });
    },
    get() { return undefined; },
    on() { return undefined; },
    effect() { return () => { /* dispose */ }; },
  };
  assert.throws(() => apply(ctx as never, {}), /stop the scheduler/);

  // mount the tools service exactly like the host would, capturing every
  // definition the plugin registers on the global layer
  interface CapturedDef {
    name: string;
    execute(a: unknown): Promise<{ ok: boolean; message: string }>;
  }
  const defs: CapturedDef[] = [];
  const scoped = {
    tools: {
      register(def: unknown) {
        defs.push(def as CapturedDef);
        return () => { /* dispose */ };
      },
    },
  };
  for (const { services, callback } of injected) {
    if (services.length === 1 && services[0] === 'tools') callback(scoped);
  }
  const ledgerTool = defs.find((d) => d.name === 'ledger');
  const correctionsTool = defs.find((d) => d.name === 'corrections');
  assert.ok(ledgerTool, 'the ledger tool must register on the global layer');
  assert.ok(correctionsTool, 'the corrections tool must register on the global layer');

  assert.equal((await ledgerTool.execute({ action: 'done', key: 'ab0004' })).ok, true);
  fs.writeFileSync(ledgerFilePath(dir), `# 账本\n${ledgerRow}`, 'utf8'); // hand re-open
  assert.equal((await ledgerTool.execute({ action: 'done', key: 'ab0004' })).ok, true); // deduped

  assert.equal((await correctionsTool.execute({ action: 'done', key: 'a00004' })).ok, true);
  fs.writeFileSync(correctionsFilePath(dir), `# 错题本\n${correctionsRow}`, 'utf8');
  assert.equal((await correctionsTool.execute({ action: 'done', key: 'a00004' })).ok, true);

  const deduped = readDedupeAudit();
  const ledgerHit = deduped.find((e) => e.id === 'ab0004');
  const correctionsHit = deduped.find((e) => e.id === 'a00004');
  assert.ok(ledgerHit, 'the production ledger wiring must audit the swallow');
  assert.ok(correctionsHit, 'the production corrections wiring must audit the swallow');
  assert.equal(correctionsHit!.archive, 'corrections-done.md');
});
