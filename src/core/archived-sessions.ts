import fs from 'node:fs';
import path from 'node:path';
import { dshHomeDir } from './paths.js';

/**
 * H-archived: the disk truth for "which sessions the user has archived" lives
 * in `<dshHome>/storages/workspace.json` under `global.archivedSessionIds`.
 * Delivering a material package into an archived session looks successful —
 * resume works — but DSH's ArchivedSessionGate rejects the pre-step and the
 * turn ends `blocked` with zero model output. Every deliver target must be
 * checked against this list before it is brought live.
 *
 * Fail-open everywhere: a missing / corrupt / oddly-shaped registry must never
 * hide a target (the visible-session picker already made that call, 2026-09-30
 * — an unreadable registry must not blank the picker, and by the same token it
 * must not blank the delivery lane). */

/** Parse the archived list out of registry text; bad JSON / non-array field
 *  degrade to an empty set (fail-open). Kept separate so callers that already
 *  hold the file contents don't re-read it. */
export function parseArchivedSessionIds(text: string): Set<string> {
  try {
    const j = JSON.parse(text) as { global?: { archivedSessionIds?: unknown } };
    const raw = j.global?.archivedSessionIds;
    if (!Array.isArray(raw)) return new Set();
    return new Set(raw.map((s) => String(s)));
  } catch {
    return new Set();
  }
}

/** Read the archived-session id list; missing file / bad JSON / non-array
 *  field all degrade to an empty set (fail-open: nothing gets filtered). */
export function loadArchivedSessionIds(registryFile?: string): Set<string> {
  const file = registryFile ?? path.join(dshHomeDir(), 'storages', 'workspace.json');
  try {
    return parseArchivedSessionIds(fs.readFileSync(file, 'utf8'));
  } catch {
    return new Set();
  }
}

/** Prefix forms are mixed on disk — some entries carry `session-`, some don't
 *  — so match both: the id as given, and the id with a leading `session-`
 *  stripped (an unprefixed archive entry must still catch `session-x`). */
export function isArchivedSession(archived: Set<string>, id: string): boolean {
  return archived.has(id) || archived.has(id.replace(/^session-/, ''));
}

/** Split deliver targets into usable / skipped, preserving the caller's
 *  order in both groups. Filtering happens at the call site (deliverPackage),
 *  never inside `deliverTargets` itself — the bindings module stays
 *  single-purpose. */
export function splitDeliverTargets<T extends { sessionId: string }>(
  all: readonly T[],
  archived: Set<string>,
): { usable: T[]; skipped: T[] } {
  const usable: T[] = [];
  const skipped: T[] = [];
  for (const t of all) {
    if (isArchivedSession(archived, t.sessionId)) skipped.push(t);
    else usable.push(t);
  }
  return { usable, skipped };
}
