// P1-1 报账加锁 (2.3.0, 账本 #d891e0): seed_report only accepts the delivery
// id of the CURRENT package, and only once. A rejected report writes nothing
// to the ring — it leaves one report_rejected audit line instead.
// DPAPI vault shells out per read/write, so tests batch whole files.
import { sandboxDir } from './_sandbox.js';
import { test, beforeEach, after } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard, type PathGuard } from '../src/core/path-guard.js';
import { FileLockTimeoutError } from '../src/core/file-lock.js';
import { resetVaultKeyCacheForTest } from '../src/vault/vault.js';
import {
  buildSeedReportTool,
  readSeedReports,
  readSeedReportsSince,
  reportFilePath,
  type ReportRejectedAudit,
} from '../src/seeds/report.js';

let sandbox = '';
beforeEach(() => {
  sandbox = sandboxDir('hb-report-lock-');
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
});
after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
});

interface Tool {
  execute(args: unknown): Promise<{ ok: boolean; message: string }>;
}

function makeLockedTool(
  currentDeliveryId: () => string,
  onRejected?: (e: ReportRejectedAudit) => void,
): { guard: PathGuard; file: string; tool: Tool } {
  const dir = workspace().dataDir;
  const guard = createPathGuard(dir);
  const file = reportFilePath(dir);
  const tool = buildSeedReportTool(guard, file, undefined, undefined, currentDeliveryId, {
    ...(onRejected ? { onRejected } : {}),
  }) as Tool;
  return { guard, file, tool };
}

test('P1-1: a forged delivery id is rejected, audited, and never reaches the ring', async () => {
  const rejected: ReportRejectedAudit[] = [];
  const { guard, file, tool } = makeLockedTool(() => 'dcur0001', (e) => rejected.push(e));

  const r = await tool.execute({ spoken: 'heartfelt', delivery_id: 'dforge01' });
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('不符'), r.message);
  // N15② (2.3.0): the rejection message must NOT echo the live package id —
  // a stray call in another session could otherwise learn it and retry with
  // it, stealing this package's report (and, with concludeSilentTurn on,
  // cutting a user chat turn).
  assert.ok(!r.message.includes('dcur0001'), `the live id must stay out of the message: ${r.message}`);
  assert.equal(readSeedReports(guard, file).length, 0, 'the forged report must not land');
  assert.deepEqual(rejected, [{
    event: 'report_rejected',
    reason: 'unknown delivery',
    deliveryId: 'dforge01',
    currentDeliveryId: 'dcur0001',
  }]);
});

test('P1-1: a missing delivery id is rejected while a delivery turn is open', async () => {
  const rejected: ReportRejectedAudit[] = [];
  const { guard, file, tool } = makeLockedTool(() => 'dcur0002', (e) => rejected.push(e));

  const missing = await tool.execute({ spoken: 'silent', reason: '不想说话' });
  const blank = await tool.execute({ spoken: 'heartfelt', delivery_id: '   ' });
  assert.equal(missing.ok, false);
  assert.equal(blank.ok, false);
  assert.ok(missing.message.includes('缺少 delivery_id'));
  assert.equal(readSeedReports(guard, file).length, 0);
  assert.deepEqual(rejected.map((e) => e.reason), ['unknown delivery', 'unknown delivery']);
  assert.equal(rejected[0]!.deliveryId, undefined, 'nothing was claimed, nothing to record');
  assert.equal(rejected[0]!.currentDeliveryId, 'dcur0002');
});

test('P1-1: with no open delivery turn any report is rejected (the 11-14 accident)', async () => {
  const rejected: ReportRejectedAudit[] = [];
  const { guard, file, tool } = makeLockedTool(() => '', (e) => rejected.push(e));

  const r = await tool.execute({ spoken: 'silent', reason: '不想说话', delivery_id: 'dself123' });
  assert.equal(r.ok, false);
  assert.equal(readSeedReports(guard, file).length, 0);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]!.reason, 'unknown delivery');
  assert.equal(rejected[0]!.deliveryId, 'dself123');
  assert.equal(rejected[0]!.currentDeliveryId, undefined, 'no turn was open');
});

test('P1-1: the first report lands normally; a second one for the same id is rejected', async () => {
  const rejected: ReportRejectedAudit[] = [];
  const { guard, file, tool } = makeLockedTool(() => 'dcur0003', (e) => rejected.push(e));

  const first = await tool.execute({ spoken: 'material', seed_ids: ['s3'], delivery_id: 'dcur0003' });
  assert.equal(first.ok, true, first.message);
  const stored = readSeedReports(guard, file);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.deliveryId, 'dcur0003');
  assert.equal(stored[0]!.spoken, 'material');
  assert.deepEqual(stored[0]!.seedIds, ['s3']);
  // the weekly window read sees the normal booking
  assert.equal(readSeedReportsSince(guard, file, stored[0]!.ts - 1).length, 1);

  const second = await tool.execute({ spoken: 'material', seed_ids: ['s3'], delivery_id: 'dcur0003' });
  assert.equal(second.ok, false);
  assert.ok(second.message.includes('只认第一次'), second.message);
  // N15③ premise pinned: the DUPLICATE message may echo the id the caller
  // itself just supplied — it already matches the live package, so nothing
  // new is revealed (unlike the mismatch branch, which must never echo it).
  assert.ok(second.message.includes('dcur0003'), second.message);
  assert.equal(readSeedReports(guard, file).length, 1, 'the duplicate must not land');
  assert.deepEqual(rejected, [{
    event: 'report_rejected',
    reason: 'duplicate delivery',
    deliveryId: 'dcur0003',
    currentDeliveryId: 'dcur0003',
  }]);
});

test('P1-1: the lock is unconditional — a tool built without a live turn rejects any report', async () => {
  const dir = workspace().dataDir;
  const guard = createPathGuard(dir);
  const file = reportFilePath(dir);
  const bare = buildSeedReportTool(guard, file) as Tool;
  const r = await bare.execute({ spoken: 'heartfelt', delivery_id: 'dlegacy1' });
  assert.equal(r.ok, false);
  assert.equal(readSeedReports(guard, file).length, 0);
});

// ── N15⑥ (2.3.0) / B2 中4: the duplicate check and the append are ONE
// critical section under withFileLock (pool.ts update() precedent). The old
// Promise.all "concurrency" test was fake — execute has no await points, so
// the two calls ran back-to-back and stayed green even without any lock. The
// real race runs the tool in TWO CHILD PROCESSES against one shared ring,
// with the onLockHeldForTest seam parking BOTH racers inside the critical
// section after their duplicate checks, released by per-racer gate files in
// a fixed order — the exact interleaving the naked check-then-act could not
// survive. Revert report.ts to the naked read-then-append and this test goes
// red (both racers pass their checks while parked → both ok).

interface RaceResult { ok: boolean; message: string }

function runRacer(repoRoot: string, fixture: string, env: NodeJS.ProcessEnv): Promise<RaceResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', fixture], { cwd: repoRoot, env });
    let out = '';
    let err = '';
    // B2 低5: a racer stuck on DPAPI/a leaked handle (NOT its own bounded 15s
    // park) must not outlive this test — its open stdio pipes keep THIS test
    // process alive after the test-level 120s timeout kills the test itself.
    // Backstop kill, cleared the moment the child exits for any reason.
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 45_000);
    child.stdout.on('data', (d: Buffer) => { out += String(d); });
    child.stderr.on('data', (d: Buffer) => { err += String(d); });
    child.on('error', (e) => {
      clearTimeout(killTimer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      const line = out.split('\n').find((l) => l.startsWith('RACE_RESULT'));
      if (!line) {
        reject(new Error(`racer printed no RACE_RESULT (exit ${code}): ${err.slice(-400) || out.slice(-400)}`));
        return;
      }
      resolve(JSON.parse(line.slice('RACE_RESULT '.length)) as RaceResult);
    });
  });
}

test('B2 中4: two real child processes race the same delivery — exactly one lands', { timeout: 120_000 }, async () => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const fixture = path.join(repoRoot, 'tests', 'fixtures', 'report-race-child.mjs');
  const raceData = path.join(sandbox, 'race-data');
  const gateA = path.join(sandbox, 'race-gate-a.open');
  const gateB = path.join(sandbox, 'race-gate-b.open');
  const markerA = path.join(sandbox, 'race-parked-a.marker');
  const markerB = path.join(sandbox, 'race-parked-b.marker');
  const baseEnv = {
    ...process.env,
    HEARTBEAT_DATA_DIR: raceData,
    RACE_DATA_DIR: raceData,
    RACE_DELIVERY_ID: 'dchild0001',
    RACE_PARK: '1', // both racers park inside the critical section
  };
  const envA = { ...baseEnv, RACE_GATE_FILE: gateA, RACE_MARKER_FILE: markerA };
  const envB = { ...baseEnv, RACE_GATE_FILE: gateB, RACE_MARKER_FILE: markerB };

  const aP = runRacer(repoRoot, fixture, envA);
  const bP = runRacer(repoRoot, fixture, envB);
  let exited = 0;
  aP.then(() => { exited += 1; }, () => { exited += 1; });
  bP.then(() => { exited += 1; }, () => { exited += 1; });

  // Choreography — deterministic, not timing-dependent. Each racer parks
  // INSIDE the critical section after its duplicate check and writes its own
  // marker; the parent releases the parked racers' gates in an order that
  // guarantees neither append can happen while a check is still pending:
  //   - both markers seen → open both gates (lockless mutation: both checks
  //     ran while both racers were parked → both append → both ok → RED);
  //   - only ONE marker (the lock holder; its sibling is parked on the LOCK,
  //     not on its gate) → open that holder's gate after a 1s grace period,
  //     well inside the sibling's 3s lock budget, then when the sibling
  //     finally parks and writes its marker, open its gate too → the sibling
  //     sees the landed entry and rejects as a duplicate.
  await new Promise<void>((resolve) => {
    const started = Date.now();
    let firstGate: string | null = null;
    let firstAt = 0;
    const opened = new Set<string>();
    const open = (g: string): void => {
      if (!opened.has(g)) {
        opened.add(g);
        fs.writeFileSync(g, 'open', 'utf8');
      }
    };
    const poll = setInterval(() => {
      const aSeen = fs.existsSync(markerA);
      const bSeen = fs.existsSync(markerB);
      if (aSeen && bSeen) {
        open(gateA);
        open(gateB);
      } else if (firstGate === null) {
        if (aSeen) { firstGate = gateA; firstAt = Date.now(); }
        else if (bSeen) { firstGate = gateB; firstAt = Date.now(); }
      } else {
        // 150ms grace: under the lock the sibling is parked on the LOCK and
        // gets its gate the moment it writes its marker — the grace only
        // needs to outlast normal scheduling jitter, and staying short keeps
        // the holder's park+DPAPI-append hold well inside the sibling's 3s
        // lock budget even when node:test runs every file in parallel on a
        // loaded machine (the fixture also retries a lock timeout, host-style).
        if (Date.now() - firstAt > 150) open(firstGate);
        if (firstGate === gateA && bSeen) open(gateB);
        if (firstGate === gateB && aSeen) open(gateA);
      }
      if (opened.size === 2 || exited === 2 || Date.now() - started > 15_000) {
        clearInterval(poll);
        resolve();
      }
    }, 25);
  });
  const [a, b] = await Promise.all([aP, bP]);

  // exactly one racer may land; the loser must be a duplicate rejection
  const oks = [a, b].filter((r) => r.ok);
  const rejectedResult = [a, b].find((r) => !r.ok);
  assert.equal(oks.length, 1, `exactly one racer lands: ${JSON.stringify([a, b])}`);
  assert.ok(rejectedResult!.message.includes('只认第一次'), rejectedResult!.message);

  // the ring (written by the children under DPAPI) holds exactly that one
  process.env.HEARTBEAT_DATA_DIR = raceData;
  resetWorkspaceForTest();
  resetVaultKeyCacheForTest();
  initWorkspace();
  const guard = createPathGuard(raceData);
  const stored = readSeedReports(guard, reportFilePath(raceData));
  assert.equal(stored.length, 1, JSON.stringify(stored));
  assert.equal(stored[0]!.deliveryId, 'dchild0001');
  assert.equal(stored[0]!.reason, '不想说话');
});

// B2 rework 中: the critical section RUNNING and failing is NOT a lock
// timeout. Before the catch was narrowed, a DPAPI/decrypt/ENOSPC fault from
// appendSeedReport (or a throwing seam) was audited as reason:"lock timeout"
// — contradicting DESIGN.md's "lock timeout = the critical section never ran"
// and sending排障 after a lock that was never the problem. Revert the catch
// to the blanket reject('lock timeout') and this goes RED on the reason.

test('B2 rework 中: a write fault inside the critical section audits "write failed", not "lock timeout"', async () => {
  const rejected: ReportRejectedAudit[] = [];
  const dir = workspace().dataDir;
  const guard = createPathGuard(dir);
  const file = reportFilePath(dir);
  const boom = new Error('simulated DPAPI write failure');
  const tool = buildSeedReportTool(guard, file, undefined, undefined, () => 'dwrite01', {
    onRejected: (e) => rejected.push(e),
    // the seam fires INSIDE the lock, between the duplicate check and the
    // append — throwing here reproduces exactly an append-side fault
    onLockHeldForTest: () => { throw boom; },
  }) as Tool;
  await assert.rejects(
    () => tool.execute({ spoken: 'silent', reason: '不想说话', delivery_id: 'dwrite01' }),
    (e: unknown) => e === boom,
    'the original write fault must surface, not be swallowed',
  );
  assert.equal(readSeedReports(guard, file).length, 0, 'the faulting report never landed');
  assert.deepEqual(rejected, [{
    event: 'report_rejected',
    reason: 'write failed',
    deliveryId: 'dwrite01',
    currentDeliveryId: 'dwrite01',
  }]);
});

test('N15⑥: execute runs under the file lock — a held lock fails closed, audits, nothing lands', async () => {
  const rejected: ReportRejectedAudit[] = [];
  const { guard, file, tool } = makeLockedTool(() => 'dlock0001', (e) => rejected.push(e));

  // Hold the lock the way another process would: an O_EXCL sibling file whose
  // pid is OURS (holderAlive never steals a live pid, ours included).
  fs.writeFileSync(`${file}.lock`, `${process.pid} held-by-test\n`, 'utf8');
  try {
    await assert.rejects(
      () => tool.execute({ spoken: 'silent', reason: '不想说话', delivery_id: 'dlock0001' }),
      (e: unknown) => e instanceof FileLockTimeoutError,
      'the locked write must fail closed, never run unlocked',
    );
    assert.equal(readSeedReports(guard, file).length, 0, 'nothing was filed without the lock');
  } finally {
    fs.rmSync(`${file}.lock`, { force: true });
  }
  // B2 中3: the failed acquisition is audited BEFORE the error surfaces — the
  // ledger stays clean and the attempt stays visible.
  assert.deepEqual(rejected, [{
    event: 'report_rejected',
    reason: 'lock timeout',
    deliveryId: 'dlock0001',
    currentDeliveryId: 'dlock0001',
  }]);
  // With the lock released the same report goes through untouched.
  const r = await tool.execute({ spoken: 'silent', reason: '不想说话', delivery_id: 'dlock0001' });
  assert.equal(r.ok, true, r.message);
  assert.equal(readSeedReports(guard, file).length, 1);
});
