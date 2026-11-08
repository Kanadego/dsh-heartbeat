// Opening a file is a "best effort, never fail" action, and the failure this
// file guards against is not an exception but a *missing* one: a spawn failure
// arrives on the child's asynchronous `error` event, so without a listener it
// escapes as an uncaughtException and takes the whole host down. That is how
// `ledger.open` / `excerpt.open` killed DSH on Linux before the platform table
// existed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openPath, openerFor, type Opener } from '../src/core/open-path.js';

test('each platform picks its own opener', () => {
  const win = openerFor('win32');
  assert.equal(win.cmd, 'cmd');
  assert.deepEqual(win.args('/x/y.md'), ['/c', 'start', '', '/x/y.md']);

  assert.equal(openerFor('darwin').cmd, 'open');
  assert.deepEqual(openerFor('darwin').args('/x/y.md'), ['/x/y.md']);

  // Unknown POSIX platforms fall through to the same xdg-open branch.
  assert.equal(openerFor('linux').cmd, 'xdg-open');
  assert.equal(openerFor('freebsd').cmd, 'xdg-open');
  assert.deepEqual(openerFor('linux').args('/x/y.md'), ['/x/y.md']);
});

test('openPath survives a machine with no opener at all', async (t) => {
  const uncaught: unknown[] = [];
  const onUncaught = (e: unknown): void => { uncaught.push(e); };
  process.on('uncaughtException', onUncaught);
  t.after(() => { process.off('uncaughtException', onUncaught); });

  // Spawning the platform's real opener would only fail where that opener is
  // missing — on Windows CI `cmd` always exists, so the assert below would stay
  // true even with the `error` listener deleted, i.e. blind to the very
  // regression this test exists for. Inject a binary that exists on no OS, so
  // the ENOENT path is reached deterministically on every runner.
  const missing: Opener = {
    cmd: `dsh-heartbeat-no-such-opener-${randomUUID()}`,
    args: (f) => [f],
  };
  assert.doesNotThrow(() => openPath('/tmp/dsh-heartbeat-open-path-probe.md', missing));

  // The async error event lands a couple of ticks later, so wait it out.
  for (let i = 0; i < 3; i += 1) await new Promise((r) => setImmediate(r));
  assert.deepEqual(uncaught, []);
});
