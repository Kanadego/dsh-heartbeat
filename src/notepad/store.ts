// 心事匣 (notepad, v2.0): ONE slot the heartbeat leaves for its NEXT self.
//
// Why one slot and not a queue: a queue lets her defer the question "what
// matters most right now" — a single slot forces that answer every beat, and
// the answer is itself the signal. It also keeps the file O(1) forever: at 8
// beats a day a three-day queue is 24 entries whose context has gone stale by
// the time she reads them.
//
// Lifecycle — the part that is not obvious, and the part most easily got wrong:
//
//   left    writeNote   a new thought (or the same text again = a KEEP)
//   shown   markDelivered   a delivery handed the note to her turn
//   let go  beginBeat   shown on an earlier beat, never touched since
//   startup free: no beat ordinal, and nothing is ever let go — restarting DSH
//           must not silently eat a thought
//
// The two ordinals make "touched since it was last shown" decidable. Both
// markDelivered and writeNote record the CURRENT beat ordinal, so:
//   dropped  <=>  shownAtBeat > touchedAtBeat
// "Shown after your last touch" is exactly "you saw it and let it pass". Note
// that the drop deliberately does NOT fire when shownAtBeat === touchedAtBeat:
// a note born or kept during this very beat's turn was never read by her, and
// a keep must not be eaten by the delivery that carried the previous text.
//
// Storage is encrypted (KHBV2, same treatment as profile.json): this is a
// private thought — more private than the ledger, which is plain Markdown on
// purpose so the user can hand-edit it. Nothing here is meant for hand-editing.
//
// Callers treat this module as best-effort: the note is a nicety, the beat is
// the point. A damaged container THROWS instead of reading as "empty" (the
// vault contract, vault.ts:303-306) so a caller can refuse to overwrite it with
// a fresh empty state; missing file is simply empty.

import path from 'node:path';
import type { PathGuard } from '../core/path-guard.js';
import { loadEncryptedText, saveEncryptedText } from '../vault/vault.js';

export function notepadFilePath(dataDir: string): string {
  return path.join(dataDir, 'notepad.json');
}

/** The one note. */
export interface NotepadNote {
  /** a HOOK for the next self, not the whole thought — she re-expands it there */
  text: string;
  /** epoch ms the thought first entered the box. A KEEP preserves it, so the
   *  age keeps counting from the day the thought arrived, not from the day she
   *  last said "still here". The time injection cannot answer this: its "since
   *  last message" clock resets on every message. */
  leftAt: number;
  /** beat ordinal when the thought entered the box (startup beats consume none) */
  beatNo: number;
  /** delivery ordinal when the thought entered the box */
  deliverNo: number;
  /** beat ordinal whose delivery last handed this note to her; null = never */
  shownAtBeat: number | null;
  /** beat ordinal of the last write (new or keep) — the other half of the
   *  drop test. Kept as a number so a pre-first-beat note (0) compares sanely. */
  touchedAtBeat: number;
}

/** Monotonic ordinals, persisted so a note ages across restarts. */
export interface NotepadCounters {
  beats: number;
  delivers: number;
}

export interface NotepadState {
  note: NotepadNote | null;
  counters: NotepadCounters;
}

/** What the delivery package needs. Formatted in material.ts; computed here. */
export interface NotepadView {
  text: string;
  /** beats started since the thought arrived (0 = it arrived during this beat) */
  beatsAgo: number;
  /** deliveries completed since the thought arrived — how often she has been
   *  woken while it sat in the box */
  wakesAgo: number;
  /** wall-clock minutes since the thought arrived */
  sinceMinutes: number;
}

function emptyState(): NotepadState {
  return { note: null, counters: { beats: 0, delivers: 0 } };
}

function int(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** A malformed note is dropped rather than failing the file — the note is one
 *  line of text, and refusing to read the slot over a missing field would cost
 *  the beat for nothing. */
function coerceNote(v: unknown): NotepadNote | null {
  const n = v as Partial<NotepadNote> | null | undefined;
  if (!n || typeof n.text !== 'string' || !n.text.trim()) return null;
  const shown = n.shownAtBeat;
  return {
    text: n.text.trim(),
    leftAt: int(n.leftAt),
    beatNo: int(n.beatNo),
    deliverNo: int(n.deliverNo),
    shownAtBeat: typeof shown === 'number' && Number.isFinite(shown) ? Math.floor(shown) : null,
    touchedAtBeat: int(n.touchedAtBeat),
  };
}

/** Read the slot. Missing file = empty; a damaged container throws (see the
 *  file header) so the caller can refuse to overwrite it. */
export function readNotepad(guard: PathGuard, file: string): NotepadState {
  const raw = loadEncryptedText(guard, file);
  if (raw === null || !raw.trim()) return emptyState();
  const parsed = JSON.parse(raw) as
    | { note?: unknown; counters?: { beats?: unknown; delivers?: unknown } }
    | null;
  return {
    note: coerceNote(parsed?.note),
    counters: {
      beats: int(parsed?.counters?.beats),
      delivers: int(parsed?.counters?.delivers),
    },
  };
}

function writeNotepad(guard: PathGuard, file: string, state: NotepadState): void {
  saveEncryptedText(guard, file, JSON.stringify(state, null, 2));
}

/**
 * Open this beat's slot. Called once at the very top of every beat, before any
 * phase can fail:
 *   - a startup beat is free: it consumes no ordinal and lets nothing go;
 *   - any other beat consumes one ordinal and lets go of a note that was shown
 *     on an earlier beat and not touched since.
 */
export function beginBeat(
  guard: PathGuard,
  file: string,
  startup: boolean,
): { beatNo: number; dropped: boolean } {
  const st = readNotepad(guard, file);
  let dropped = false;
  if (!startup) {
    st.counters.beats += 1;
    const note = st.note;
    if (note && note.shownAtBeat !== null && note.shownAtBeat > note.touchedAtBeat) {
      st.note = null;
      dropped = true;
    }
  }
  writeNotepad(guard, file, st);
  return { beatNo: st.counters.beats, dropped };
}

/**
 * A delivery package was actually handed to her turn: bump the wake ordinal and
 * mark the note shown — which is what lets the next beat let it go, unless she
 * touches it in between. Called AFTER the turn, never at prompt-build time: a
 * package that died in the final quiet-hours check, or came back deferred
 * because the target session was busy, never reached her and must not age it.
 *
 * The one subtler rule: a note BORN during this beat's turn (beatNo === the
 * current ordinal) gets its wake ordinal anchored to the delivery now
 * completing. It was not "woken by" the beat it was born in, and leaving the
 * count uncorrected would make every first read say "woken once".
 */
export function markDelivered(guard: PathGuard, file: string): number {
  const st = readNotepad(guard, file);
  st.counters.delivers += 1;
  if (st.note) {
    st.note.shownAtBeat = st.counters.beats;
    if (st.note.beatNo === st.counters.beats) st.note.deliverNo = st.counters.delivers;
  }
  writeNotepad(guard, file, st);
  return st.counters.delivers;
}

/**
 * Leave a thought. Writing the SAME text is a KEEP: the note is the same
 * thought, so its age (leftAt / beatNo / deliverNo) is preserved and only the
 * "last touched" hinge moves. Writing anything else REPLACES the note — and
 * that replacement is exactly how the old thought is let go. Ordinals come from
 * the persisted counters, so the caller (a model tool) needs to know nothing
 * about beats.
 */
export function writeNote(
  guard: PathGuard,
  file: string,
  text: string,
  now = Date.now(),
): { note: NotepadNote; kept: boolean } {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('notepad note must not be empty');
  const st = readNotepad(guard, file);
  const prev = st.note;
  const kept = prev !== null && prev.text === clean;
  const note: NotepadNote = kept
    ? { ...prev, shownAtBeat: null, touchedAtBeat: st.counters.beats }
    : {
      text: clean,
      leftAt: now,
      beatNo: st.counters.beats,
      deliverNo: st.counters.delivers,
      shownAtBeat: null,
      touchedAtBeat: st.counters.beats,
    };
  st.note = note;
  writeNotepad(guard, file, st);
  return { note, kept };
}

/** Let the note go on purpose. Returns the note that was dropped, or null when
 *  the slot was already empty. */
export function clearNote(guard: PathGuard, file: string): NotepadNote | null {
  const st = readNotepad(guard, file);
  const prev = st.note;
  if (!prev) return null;
  st.note = null;
  writeNotepad(guard, file, st);
  return prev;
}

/** The package-facing view of the note, or null when the slot is empty. */
export function notepadView(st: NotepadState, now = Date.now()): NotepadView | null {
  const n = st.note;
  if (!n) return null;
  return {
    text: n.text,
    beatsAgo: Math.max(0, st.counters.beats - n.beatNo),
    wakesAgo: Math.max(0, st.counters.delivers - n.deliverNo),
    sinceMinutes: n.leftAt > 0 ? Math.max(0, Math.round((now - n.leftAt) / 60_000)) : 0,
  };
}
