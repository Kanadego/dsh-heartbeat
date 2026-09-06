// Path whitelist guard (requirement 8 / design doc §10.2).
//
// Every fs write/delete must have its target canonicalized first, then be
// checked against the canonical workspace prefix with a separator boundary.
// A raw startsWith check is bypassable via "..", symlinks/junctions, and
// case variants; canonical realpath closes all of those on Windows.

import fs from 'node:fs';
import path from 'node:path';

export class PathOutsideWorkspaceError extends Error {
  constructor(target: string, workspace: string) {
    super(`path outside workspace: "${target}" (workspace: "${workspace}")`);
    this.name = 'PathOutsideWorkspaceError';
  }
}

/**
 * Resolve to an absolute canonical path. For targets that do not exist yet,
 * realpath the deepest existing ancestor and re-append the virtual tail, so
 * planned files under the workspace validate while `..` escapes still resolve
 * through the real filesystem.
 */
export function canonicalize(target: string): string {
  const abs = path.resolve(target);
  try {
    return fs.realpathSync(abs);
  } catch {
    // Walk up from the missing leaf, recording each missing component, until
    // an existing ancestor is found; re-append the missing tail afterwards.
    const tail: string[] = [];
    let dir = abs;
    for (;;) {
      const base = path.basename(dir);
      const parent = path.dirname(dir);
      if (parent === dir) {
        throw new Error(`cannot canonicalize "${target}": no existing ancestor`);
      }
      tail.push(base);
      dir = parent;
      try {
        const realDir = fs.realpathSync(dir);
        return path.join(realDir, ...tail.reverse());
      } catch {
        continue;
      }
    }
  }
}

/**
 * True when `targetCanon` equals the workspace dir or lies under it.
 * Comparison is case-insensitive (Windows filesystems) and requires a
 * separator boundary so `D:\ws-data-evil` does not match workspace `D:\ws-data`.
 */
export function isInsideWorkspace(workspaceCanon: string, targetCanon: string): boolean {
  const norm = (p: string) => {
    let n = path.normalize(p).toLowerCase();
    if (!n.endsWith(path.sep)) n += path.sep;
    return n;
  };
  const w = norm(workspaceCanon);
  const t = norm(targetCanon);
  return t === w || t.startsWith(w);
}

export interface PathGuard {
  /** Canonical workspace boundary. */
  readonly workspace: string;
  /** Canonicalize then validate; returns the canonical path or throws. */
  assert(target: string): string;
  /** Canonicalize then validate; returns null instead of throwing. */
  check(target: string): string | null;
}

export function createPathGuard(workspaceDir: string): PathGuard {
  const workspace = canonicalize(workspaceDir);
  const guard: PathGuard = {
    workspace,
    check(target: string): string | null {
      const canon = canonicalize(target);
      return isInsideWorkspace(workspace, canon) ? canon : null;
    },
    assert(target: string): string {
      const canon = guard.check(target);
      if (canon === null) throw new PathOutsideWorkspaceError(target, workspace);
      return canon;
    },
  };
  return guard;
}
