// B2 中4 fixture: one racer process for the seed_report concurrency test.
//
// Runs the REAL seed_report tool against a shared sandbox ring. Every racer
// parks INSIDE the critical section (via the onLockHeldForTest seam) between
// its duplicate check and its append: it writes RACE_MARKER_FILE, then spins
// until its own RACE_GATE_FILE appears (bounded, so a broken parent cannot
// hang the suite). The parent choreographs the two racers' gate files, which
// pins the interleaving exactly — both checks run while neither racer has
// appended — instead of racing process-startup timing. Under the real lock
// the second racer only reaches its hook after the first releases, sees the
// landed entry, and rejects as a duplicate; without the lock BOTH racers
// pass their checks while parked and both append — the naked check-then-act
// double-books, and the test goes red.
//
// Prints one line `RACE_RESULT {json}` on success; exits non-zero on a crash.
import fs from 'node:fs';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../../src/core/paths.js';
import { createPathGuard } from '../../src/core/path-guard.js';
import { buildSeedReportTool, reportFilePath } from '../../src/seeds/report.js';

const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const deliveryId = process.env.RACE_DELIVERY_ID ?? '';
const gateFile = process.env.RACE_GATE_FILE ?? '';
const markerFile = process.env.RACE_MARKER_FILE ?? '';
const park = process.env.RACE_PARK ?? ''; // '1' = park on gate (15s cap), 'stuck' = kill-guard demo

process.env.HEARTBEAT_DATA_DIR = process.env.RACE_DATA_DIR ?? '';
resetWorkspaceForTest();
initWorkspace();
const dir = workspace().dataDir;
const guard = createPathGuard(dir);
const file = reportFilePath(dir);

const tool = buildSeedReportTool(guard, file, undefined, undefined, () => deliveryId, {
  onLockHeldForTest: park
    ? () => {
        // Park INSIDE the critical section: signal the parent, then wait for
        // this racer's own gate file (bounded, so a broken parent cannot hang
        // the suite). RACE_PARK='stuck' (kill-guard demo only, never used by
        // the suite) simulates a racer wedged on DPAPI/a leaked handle: it
        // ignores its gate entirely and spins until it is SIGKILLed — which is
        // exactly the leak the parent's 45s kill backstop exists to reclaim.
        if (markerFile) fs.writeFileSync(markerFile, `${process.pid}\n`, 'utf8');
        if (park === 'stuck') {
          for (;;) sleepSync(100);
        }
        const deadline = Date.now() + 15_000;
        while (!fs.existsSync(gateFile)) {
          if (Date.now() > deadline) break;
          sleepSync(25);
        }
      }
    : undefined,
});

// The tool rethrows FileLockTimeoutError when its 3s lock budget runs out —
// the host would retry against a lock that is probably still held. Mirror that
// with a bounded retry so a slow DPAPI append (0.7–2.7s measured on a loaded
// machine) in the LOCK HOLDER cannot crash the sibling instead of letting it
// reach the expected duplicate rejection. The lockless mutation never hits
// lock contention (both racers park straight through), so retries cannot mask
// the double-booking this test hunts.
let r;
for (let attempt = 1; ; attempt++) {
  try {
    r = await tool.execute({ spoken: 'silent', reason: '不想说话', delivery_id: deliveryId });
    break;
  } catch (e) {
    if (e?.name !== 'FileLockTimeoutError' || attempt >= 5) throw e;
    sleepSync(100);
  }
}
console.log('RACE_RESULT ' + JSON.stringify({ ok: r.ok, message: r.message }));
