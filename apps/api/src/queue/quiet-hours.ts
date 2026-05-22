/**
 * Quiet-hours filter — given a user's quiet window and the current moment
 * (in their timezone), returns true if we should suppress the notification.
 *
 * Edge case: quietHoursEnd <= quietHoursStart means the window wraps midnight
 * (e.g. 22:00–08:00). We handle both shapes.
 */
export function isInQuietHours(input: {
  start: string | null;
  end: string | null;
  /** "HH:MM" in the user's local timezone — caller is responsible for the conversion. */
  nowLocal: string;
}): boolean {
  const { start, end, nowLocal } = input;
  if (!start || !end) return false;
  const s = toMin(start);
  const e = toMin(end);
  const n = toMin(nowLocal);
  if (s === e) return false;
  if (s < e) return n >= s && n < e;
  // Wrap: window straddles midnight (e.g. 22:00–08:00).
  return n >= s || n < e;
}

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Returns the current time in `HH:MM` in the given IANA timezone. Uses
 * `Intl.DateTimeFormat` so we don't pull in moment/luxon for one call.
 */
export function localHHMM(tz: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).format(now);
  // en-GB produces "HH:MM"
  return parts;
}

/**
 * Returns today's date as `YYYY-MM-DD` in the given IANA timezone. Used as
 * the dedupe-key date so a digest is "one per local day", not "one per UTC day".
 */
export function localDate(tz: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return parts;
}
