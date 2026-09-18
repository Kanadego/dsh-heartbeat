// Vision bridge tests (2026-09-18 spec ①②): ModLens resolution, summary
// extraction, spawn orchestration with "use then burn" discipline, and the
// spec-② privacy rule (failure -> no summary -> caller withholds titles).

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import { encryptFile } from '../src/vault/vault.js';
import { screenJpgPath } from '../src/screen/screenpulse.js';
import { describeScreenShot, extractSummary, resolveModlensMain } from '../src/screen/vision.js';

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-vision-'));
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  guard = createPathGuard(workspace().dataDir);
});

after(() => {
  resetWorkspaceForTest();
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
});

test('extractSummary: handles the known envelopes and rejects empty output', () => {
  assert.equal(extractSummary(JSON.stringify({ result: { summary: '正在爬塔(杀戮尖塔2)' } })), '正在爬塔(杀戮尖塔2)');
  assert.equal(extractSummary(JSON.stringify({ summary: '在写文档' })), '在写文档');
  assert.equal(extractSummary(JSON.stringify({ result: { ocr: { full_text: '任务管理器' } } })), '任务管理器');
  assert.equal(extractSummary(JSON.stringify({})), null);
  assert.equal(extractSummary('{"broken'), null);
  assert.equal(extractSummary('一段纯文本输出也可以'), '一段纯文本输出也可以');
  assert.equal(extractSummary(''), null);
  // long summaries are capped
  assert.equal(extractSummary(JSON.stringify({ summary: 'x'.repeat(500) }))!.length, 300);
});

test('resolveModlensMain: null when the package is absent, real file when present', () => {
  const absent = resolveModlensMain(import.meta.url);
  // workspace checkout may or may not sit under a tree with modlens; both are
  // legal, but when it resolves the file MUST exist
  if (absent !== null) assert.ok(fs.existsSync(absent));
  const fake = resolveModlensMain('file://' + path.join(sandbox, 'nope', 'x.js'));
  assert.equal(fake, null);
});

test('describeScreenShot: happy path — CLI called on the decrypted shot, temp files burned', async () => {
  const tmpShot = path.join(workspace().tmpDir, 'plain.jpg');
  fs.writeFileSync(tmpShot, 'fakejpeg');
  encryptFile(guard, tmpShot, screenJpgPath(workspace()));
  fs.rmSync(tmpShot, { force: true });
  const seen: { img?: string; out?: string } = {};
  const spawnCli = async (_cmd: string, args: string[]) => {
    seen.img = args[2];
    seen.out = args[4];
    assert.equal(args[1], '-i');
    assert.equal(args[3], '-o');
    assert.equal(args[5], '-p');
    assert.equal(args[6], 'openai', 'provider pinned away from the Antigravity default');
    fs.writeFileSync(seen.out!, JSON.stringify({ result: { summary: '在开船(wws)' } }));
    return { code: 0 };
  };
  const mainPath = path.join(workspace().tmpDir, 'fake-modlens-main.js');
  fs.writeFileSync(mainPath, '// stub');
  const v = await describeScreenShot(guard, workspace(), { moduleUrl: import.meta.url, mainPath, spawnCli });
  assert.equal(v.ok, true);
  assert.equal(v.summary, '在开船(wws)');
  assert.ok(fs.existsSync(seen.img!) === false, 'unlocked shot burned');
  assert.ok(fs.existsSync(seen.out!) === false, 'vision output burned');
  // the encrypted original survives for the next consumer
  assert.ok(fs.existsSync(screenJpgPath(workspace())));
});

test('describeScreenShot: CLI failure and no-shot both yield ok:false (no summary)', async () => {
  // the exit-3 branch needs a shot to exist, else no-shot fires first
  const tmpShot = path.join(workspace().tmpDir, 'plain.jpg');
  fs.writeFileSync(tmpShot, 'fakejpeg');
  encryptFile(guard, tmpShot, screenJpgPath(workspace()));
  fs.rmSync(tmpShot, { force: true });
  const fail = await describeScreenShot(guard, workspace(), {
    moduleUrl: import.meta.url,
    mainPath: path.join(workspace().tmpDir, 'stub.js'),
    spawnCli: async () => ({ code: 3 }),
  });
  assert.equal(fail.ok, false);
  assert.equal(fail.summary, null);
  assert.match(fail.error!, /exit 3/);
  // remove the encrypted shot so this branch really is the no-shot path
  fs.rmSync(screenJpgPath(workspace()), { force: true });
  const none = await describeScreenShot(guard, workspace(), {
    moduleUrl: import.meta.url,
    mainPath: path.join(workspace().tmpDir, 'stub.js'),
    spawnCli: async () => ({ code: 0 }),
  });
  assert.equal(none.ok, false);
  assert.match(none.error!, /no screenshot/);
});

test('describeScreenShot: spawn rejection (timeout) is caught, not thrown', async () => {
  const tmpShot = path.join(workspace().tmpDir, 'plain.jpg');
  fs.writeFileSync(tmpShot, 'fakejpeg');
  encryptFile(guard, tmpShot, screenJpgPath(workspace()));
  fs.rmSync(tmpShot, { force: true });
  const v = await describeScreenShot(guard, workspace(), {
    moduleUrl: import.meta.url,
    mainPath: path.join(workspace().tmpDir, 'stub.js'),
    spawnCli: async () => { throw new Error('modlens timeout (115000ms)'); },
  });
  assert.equal(v.ok, false);
  assert.match(v.error!, /timeout/);
});

test('provider pin: data/settings/vision.json overrides the default provider', async () => {
  const tmpShot = path.join(workspace().tmpDir, 'plain.jpg');
  fs.writeFileSync(tmpShot, 'fakejpeg');
  encryptFile(guard, tmpShot, screenJpgPath(workspace()));
  fs.rmSync(tmpShot, { force: true });
  fs.writeFileSync(path.join(workspace().settingsDir, 'vision.json'), JSON.stringify({ provider: 'gemini-api' }));
  let pinned = '';
  const spawnCli = async (_cmd: string, args: string[]) => {
    pinned = args[args.indexOf('-p') + 1]!;
    const out = args[args.indexOf('-o') + 1]!;
    fs.writeFileSync(out, JSON.stringify({ result: { summary: 'ok' } }));
    return { code: 0 };
  };
  const v = await describeScreenShot(guard, workspace(), { moduleUrl: import.meta.url, mainPath: path.join(workspace().tmpDir, 'stub.js'), spawnCli });
  assert.equal(v.ok, true);
  assert.equal(pinned, 'gemini-api');
});
