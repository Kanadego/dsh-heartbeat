// Shared HH:MM window arithmetic.
//
// H-14: quiet hours (`gate.ts`) and wander windows (`browse.ts`) each carried
// their own copy of this comparison, and only ONE of them handled a window
// that crosses midnight — so a `22:00-02:00` wander window silently never
// matched. One implementation, one set of semantics, no drift.
//
// Interval is left-closed / right-open, so `22:00-02:00` and `02:00-06:00`
// never overlap and every minute belongs to at most one window.

const HH_MM = /^(\d{1,2}):(\d{2})$/;

/** "22:30" -> 1350; null when malformed (callers treat that as "never matches"). */
export function parseHhMm(text: string): number | null {
  const m = HH_MM.exec(String(text).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function minutesOfDay(now: Date): number {
  return now.getHours() * 60 + now.getMinutes();
}

/** TRUE when `mins` (minutes since local midnight) falls inside [start, end). */
export function inHhMmWindow(start: string, end: string, mins: number): boolean {
  const s = parseHhMm(start);
  const e = parseHhMm(end);
  if (s === null || e === null) return false;
  if (s === e) return false; // zero-length window matches nothing
  return s > e ? mins >= s || mins < e : mins >= s && mins < e;
}
