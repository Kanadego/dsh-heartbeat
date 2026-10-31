// v2.1.0 — the `settings` service must NOT sit in the module-level `inject`.
//
// Why a source-shape assertion instead of an apply() test: `src/index.ts` needs
// the whole host (agents, storage, guard paths) to reach apply, so a behavioural
// test would be a host emulation in disguise. The regression this guards is
// mechanical — one name added back to that array — and it is expensive: on DSH
// desktop 0.2.1-rc.3 the plugin sat at `pending (waiting for service: settings)`
// and took the shell down ("Web RPC failed" in openInitialWindow, crash dialog
// with three dead buttons). A text assertion catches that edit before release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'src', 'index.ts'), 'utf8');

test('module-level inject lists agents only (settings is attached via ctx.inject)', () => {
  const m = /export const inject = \[([^\]]*)\]/.exec(source);
  assert.ok(m, 'expected an export const inject = [...] declaration');
  const names = (m[1] ?? '')
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  assert.deepEqual(names, ['agents'], 'module-level inject must stay [agents]: ' + JSON.stringify(names));
});

test('settings is requested lazily through ctx.inject', () => {
  assert.match(source, /ctx\.inject\(\['settings'\]/, 'expected ctx.inject([settings], ...)');
});

test('no import of @deepseek-ai/dsh-settings is left (the fallback it served is gone)', () => {
  // Comments mention the package on purpose, so match only an actual import.
  assert.doesNotMatch(source, /from '@deepseek-ai\/dsh-settings'|import\('@deepseek-ai\/dsh-settings'\)/);
});
