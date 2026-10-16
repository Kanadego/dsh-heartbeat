// Recursive file matching below a data directory (HB-07 / HB-21).
//
// The burn list and `profile wipe` both need "every file anywhere under
// dataDir whose name matches this pattern". Migration backups
// (`${abs}.bak-migrate-${stamp}`) and crash leftovers (`.incoming-`) sit next
// to whatever they copied, so a target that only reads the top level would
// leave a full copy of the memory behind.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Relative POSIX-style paths of files below `root` whose NAME matches `match`,
 * sorted. The pattern is used as a plain test: a `g` flag is stripped so a
 * caller-supplied regexp cannot carry lastIndex state between files. `root`
 * must already be resolved/validated by the caller's path guard.
 */
export function matchFilesRecursive(root: string, match: RegExp): string[] {
  const re = new RegExp(match.source, match.flags.replace(/g/g, ''));
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(path.join(dir, e.name), rel);
        continue;
      }
      if (!e.isFile()) continue;
      if (re.test(e.name)) out.push(rel);
    }
  };
  walk(root, '');
  return out.sort();
}
