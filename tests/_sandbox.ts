// Test sandboxes live under the OS temp dir and must not outlive the test run.
//
// The leak: files that build one sandbox per case (beforeEach) but only clean up
// in a file-level `after` remove nothing but the last one — that is how 16k `hb-*`
// shells piled up in %TEMP% between 2026-09-06 and 2026-10-07. Registering a
// single synchronous cleanup on process exit covers every creation pattern
// (beforeEach, per-test const, helper function) without touching each site.
// `node --test` gives each file its own process, so the registry never crosses files.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dirs = new Set<string>();
let hooked = false;

/** Create a temp sandbox directory that is removed when the test process exits. */
export function sandboxDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.add(dir);
  if (!hooked) {
    hooked = true;
    process.on('exit', () => {
      for (const d of dirs) {
        try {
          fs.rmSync(d, { recursive: true, force: true });
        } catch {
          // A failed cleanup must not turn a green run red.
        }
      }
      dirs.clear();
    });
  }
  return dir;
}
