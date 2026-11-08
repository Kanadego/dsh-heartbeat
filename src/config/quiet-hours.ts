// Quiet hours (v2.2, panel entry): pure helpers for the settings-card
// quiet-hours inputs. The value's source of truth is the policy user layer
// (data/settings/policy.json gate.quietHours) — like psyEnabled, it never
// touches ui.json — and the runtime policy is a live reference, so writing the
// runtime object makes evaluateGate pick it up on the very next beat.

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Strict HH:MM validation: returns the input unchanged when it matches
 * `HH:MM` (00:00-23:59); anything else — "24:00", "1:30", "01:60", "",
 * null, non-strings — returns null.
 */
export function normalizeHhMm(v: unknown): string | null {
  return typeof v === 'string' && HHMM.test(v) ? v : null;
}

/**
 * Three-state resolver for the panel's two time inputs:
 * - both values given and valid → use the new pair;
 * - only one given (the other undefined/null) → keep `current` for it;
 * - any given-but-invalid value → null (never silently swallowed — the caller
 *   turns that into a user-visible error).
 * When neither value is given, returns `current` unchanged.
 */
export function resolveQuietHours(
  startRaw: unknown,
  endRaw: unknown,
  current: { start: string; end: string },
): { start: string; end: string } | null {
  const given = (v: unknown): boolean => v !== undefined && v !== null;
  if (!given(startRaw) && !given(endRaw)) return { start: current.start, end: current.end };
  const start = normalizeHhMm(startRaw);
  const end = normalizeHhMm(endRaw);
  if ((given(startRaw) && !start) || (given(endRaw) && !end)) return null;
  return {
    start: start ?? current.start,
    end: end ?? current.end,
  };
}
