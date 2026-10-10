// issue #2 (2026-10-10): a package-local data dir is relocated to
// `$DSH_HOME/heartbeat-data` on first sight. The point of the whole exercise is
// that user data survives a reinstall, so these cases cover the payload test,
// the byte-level verify gate, the happy path and every path that must leave the
// original tree untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxDir } from './_sandbox.js';
import { hasPayload, relocateDataDir, verifyTrees } from '../src/core/data-relocate.js';

function box(): { root: string; src: string; dst: string } {
  const root = sandboxDir('hb-relocate-');
  return {
    root,
    src: path.join(root, 'pkg', 'data'),
    dst: path.join(root, 'home', 'heartbeat-data'),
  };
}

function write(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Six real files plus one scratch file that must never be copied. */
function legacyTree(src: string): void {
  write(path.join(src, 'settings', 'ui.json'), '{"intervalMin":60}\n');
  write(path.join(src, 'profile.json'), '{"name":"kohaku"}\n');
  write(path.join(src, 'profile_journal.jsonl'), '{"turn":1}\n{"turn":2}\n');
  write(path.join(src, 'logs', 'heartbeat.jsonl'), '{"event":"plugin_init"}\n');
  write(path.join(src, 'ledger.md'), '- #1 test\n');
  write(
    path.join(src, 'gate.json'),
    Buffer.concat([Buffer.from('KHBV1', 'ascii'), Buffer.from([0, 1, 2, 3])]),
  );
  write(path.join(src, 'tmp', 'leftover.plain'), 'scratch\n');
}

test('hasPayload: only real data counts, not the bootstrap skeleton or scratch', () => {
  const { src } = box();
  assert.equal(hasPayload(src), false, 'missing dir');
  for (const dir of ['settings', 'logs', 'tmp', 'exports']) {
    fs.mkdirSync(path.join(src, dir), { recursive: true });
  }
  assert.equal(hasPayload(src), false, 'empty skeleton is not payload');
  write(path.join(src, 'tmp', 'scratch.plain'), 'x');
  assert.equal(hasPayload(src), false, 'tmp is scratch');
  write(path.join(src, 'settings', 'ui.json'), '{}');
  assert.equal(hasPayload(src), true);
});

test('verifyTrees gates on the file list, the sizes and the bytes', () => {
  const { root, src } = box();
  const copy = path.join(root, 'copy');
  legacyTree(src);
  fs.cpSync(src, copy, { recursive: true });

  const clean = verifyTrees(src, copy);
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.problems, []);
  assert.equal(clean.files, 6, 'tmp/ is skipped on both sides');
  assert.ok(clean.bytes > 0);

  write(path.join(copy, 'ledger.md'), '- #1 lesT\n'); // same size, different byte
  write(path.join(copy, 'settings', 'ui.json'), '{}\n'); // shorter: size gate
  fs.rmSync(path.join(copy, 'profile.json'));
  write(path.join(copy, 'stray.txt'), 'x');
  const bad = verifyTrees(src, copy);
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.includes('content differs: ledger.md'));
  assert.ok(bad.problems.includes('size differs: settings/ui.json (19 -> 3)'));
  assert.ok(bad.problems.includes('missing: profile.json'));
  assert.ok(bad.problems.includes('unexpected: stray.txt'));
});

test('verifyTrees reports a missing copy instead of throwing', () => {
  const { root, src } = box();
  legacyTree(src);
  const report = verifyTrees(src, path.join(root, 'nowhere'));
  assert.equal(report.ok, false);
  assert.equal(report.files, 0);
  assert.equal(report.problems.length, 1);
});

test('verifyTrees warns about unreadable plaintext without failing the move', () => {
  const { root, src } = box();
  const copy = path.join(root, 'copy');
  legacyTree(src);
  write(path.join(src, 'profile.json'), '{"name":'); // damaged long before the move
  fs.cpSync(src, copy, { recursive: true });
  const report = verifyTrees(src, copy);
  assert.equal(report.ok, true, 'an identical copy of damaged data is still the user data');
  assert.deepEqual(report.warnings, ['unparseable: profile.json']);
});

test('verifyTrees accepts KHBV1 containers as opaque bytes', () => {
  const { root, src } = box();
  const copy = path.join(root, 'copy');
  legacyTree(src);
  fs.cpSync(src, copy, { recursive: true });
  assert.deepEqual(verifyTrees(src, copy).warnings, []);
});

test('relocateDataDir moves the tree out, verifies it, then deletes the original', () => {
  const { src, dst } = box();
  legacyTree(src);
  const result = relocateDataDir({ srcDir: src, dstDir: dst, now: Date.UTC(2026, 9, 10, 5, 0, 0) });
  assert.equal(result.action, 'relocated');
  if (result.action !== 'relocated') return;
  assert.equal(result.files, 6);
  assert.equal(result.srcDir, src);
  assert.equal(result.dstDir, dst);
  assert.deepEqual(result.leftovers, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(fs.existsSync(src), false, 'legacy tree removed');
  assert.equal(fs.existsSync(result.backupDir), false, 'backup removed after the move');
  assert.equal(fs.existsSync(path.join(dst, 'profile.json')), true);
  assert.deepEqual(fs.readdirSync(path.join(dst, 'settings')), ['ui.json']);
  assert.equal(fs.existsSync(path.join(dst, 'tmp')), false, 'scratch is never copied');
});

test('relocateDataDir refuses to overwrite a destination that already has data', () => {
  const { src, dst } = box();
  legacyTree(src);
  write(path.join(dst, 'profile.json'), '{"name":"newer"}\n');
  const result = relocateDataDir({ srcDir: src, dstDir: dst });
  assert.equal(result.action, 'skipped');
  if (result.action !== 'skipped') return;
  assert.equal(result.reason, 'destination-exists');
  assert.equal(fs.existsSync(path.join(src, 'profile.json')), true, 'source untouched');
  assert.equal(fs.readFileSync(path.join(dst, 'profile.json'), 'utf8'), '{"name":"newer"}\n');
});

test('relocateDataDir takes over an empty destination skeleton', () => {
  const { src, dst } = box();
  legacyTree(src);
  for (const dir of ['settings', 'logs', 'tmp', 'exports']) {
    fs.mkdirSync(path.join(dst, dir), { recursive: true });
  }
  const result = relocateDataDir({ srcDir: src, dstDir: dst });
  assert.equal(result.action, 'relocated');
  assert.equal(fs.existsSync(path.join(dst, 'profile.json')), true);
  assert.equal(fs.existsSync(path.join(src, 'profile.json')), false);
});

test('relocateDataDir skips a missing or empty source', () => {
  const { src, dst } = box();
  assert.deepEqual(relocateDataDir({ srcDir: src, dstDir: dst }), {
    action: 'skipped',
    reason: 'source-missing',
  });
  for (const dir of ['settings', 'logs', 'tmp', 'exports']) {
    fs.mkdirSync(path.join(src, dir), { recursive: true });
  }
  assert.deepEqual(relocateDataDir({ srcDir: src, dstDir: dst }), {
    action: 'skipped',
    reason: 'no-payload',
  });
});

test('relocateDataDir keeps the source when a destination with data wins', () => {
  const { src, dst } = box();
  legacyTree(src);
  write(path.join(dst, 'seeds.jsonl'), '{"id":"s1"}\n');
  const result = relocateDataDir({ srcDir: src, dstDir: dst, now: 0 });
  assert.equal(result.action, 'skipped');
  assert.equal(fs.existsSync(path.join(src, 'ledger.md')), true);
});
