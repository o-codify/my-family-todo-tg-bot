import { customAlphabet } from 'nanoid';
import { and, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import { db } from '../db/client';
import {
  families,
  icsTokens,
  taskOccurrences,
  tasks,
  type IcsTokenRow,
} from '../db/schema';

const tokenAlphabet = customAlphabet(
  'abcdefghijklmnopqrstuvwxyz0123456789',
  32,
);

/**
 * ICS token issue / revoke / list. We keep one active token per
 * (user, family) — re-issuing rotates: the old row is marked revoked,
 * a new one is inserted. Token strings are 32 chars from a 36-char
 * alphabet (~165 bits of entropy) — safe to put in a URL.
 */

export async function issueToken(input: {
  userId: string;
  familyId: string;
}): Promise<IcsTokenRow> {
  // Revoke any existing live token for this (user, family).
  await db
    .update(icsTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(icsTokens.userId, input.userId),
        eq(icsTokens.familyId, input.familyId),
        isNull(icsTokens.revokedAt),
      ),
    );
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = tokenAlphabet();
    try {
      const [row] = await db
        .insert(icsTokens)
        .values({
          userId: input.userId,
          familyId: input.familyId,
          token,
        })
        .returning();
      return row!;
    } catch (err) {
      // 23505 = unique_violation on the token column; retry with new.
      if ((err as { code?: string }).code !== '23505') throw err;
    }
  }
  throw new Error('ICS token generation collided 5 times — giving up');
}

export async function findActiveToken(input: {
  userId: string;
  familyId: string;
}): Promise<IcsTokenRow | null> {
  const row = await db.query.icsTokens.findFirst({
    where: and(
      eq(icsTokens.userId, input.userId),
      eq(icsTokens.familyId, input.familyId),
      isNull(icsTokens.revokedAt),
    ),
  });
  return row ?? null;
}

export async function revokeActiveToken(input: {
  userId: string;
  familyId: string;
}): Promise<boolean> {
  const res = await db
    .update(icsTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(icsTokens.userId, input.userId),
        eq(icsTokens.familyId, input.familyId),
        isNull(icsTokens.revokedAt),
      ),
    )
    .returning({ id: icsTokens.id });
  return res.length > 0;
}

/** Look up the family-id this token authorises. Marks lastUsedAt for
 *  observability. Returns null when the token is unknown / revoked. */
export async function resolveToken(token: string): Promise<{
  userId: string;
  familyId: string;
} | null> {
  const row = await db.query.icsTokens.findFirst({
    where: and(eq(icsTokens.token, token), isNull(icsTokens.revokedAt)),
  });
  if (!row) return null;
  // Fire-and-forget last-used update — the calendar app might poll
  // every 30 min, no point waiting on the write.
  void db
    .update(icsTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(icsTokens.id, row.id))
    .catch(() => undefined);
  return { userId: row.userId, familyId: row.familyId };
}

/**
 * Generate an ICS document for the family's occurrences.
 * Scope:
 *   - Both pending and done occurrences — the user explicitly wants
 *     completed tasks visible too. Done events get a ✓ prefix + a
 *     STATUS:COMPLETED line so a calendar that knows STATUS can show
 *     them struck through. Skipped/expired are dropped — they're noise.
 *   - 90 days back, 365 days forward for dated occurrences — calendar
 *     apps cache; we err wide so a once-a-day fetch sees the next year.
 *   - Floating completions (no scheduledDate, status=done, completedAt
 *     set — typical for singleShot tasks finished without a planned
 *     date) are anchored on completedAt's calendar date. Without this
 *     anchor they'd be invisible despite existing in the app.
 *
 * The output uses CRLF line endings per RFC 5545. We don't fold lines
 * (the RFC asks for ≤75 octets per line) — modern parsers accept
 * unfolded lines and our titles are usually short.
 */
export async function generateFamilyIcs(input: {
  familyId: string;
}): Promise<string> {
  const family = await db.query.families.findFirst({
    where: eq(families.id, input.familyId),
  });
  if (!family) return emptyIcs('Family');

  const today = new Date();
  const from = new Date(today.getTime() - 90 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const to = new Date(today.getTime() + 365 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  // For floating completions we anchor on completedAt. Use the same
  // 90-day lookback so an old completion doesn't pollute the calendar.
  const completedFrom = new Date(today.getTime() - 90 * 86_400_000);

  const rows = await db
    .select({
      id: taskOccurrences.id,
      scheduledDate: taskOccurrences.scheduledDate,
      scheduledTime: taskOccurrences.scheduledTime,
      status: taskOccurrences.status,
      completedAt: taskOccurrences.completedAt,
      title: tasks.title,
      description: tasks.description,
    })
    .from(taskOccurrences)
    .innerJoin(tasks, eq(taskOccurrences.taskId, tasks.id))
    .where(
      and(
        eq(tasks.familyId, input.familyId),
        isNull(tasks.archivedAt),
        inArray(taskOccurrences.status, ['pending', 'done']),
        or(
          // Dated rows inside the visible window.
          and(
            gte(taskOccurrences.scheduledDate, from),
            lte(taskOccurrences.scheduledDate, to),
          ),
          // Floating completions: no scheduledDate, but a recent
          // completedAt — anchor those on the completion date below.
          and(
            isNull(taskOccurrences.scheduledDate),
            gte(taskOccurrences.completedAt, completedFrom),
          ),
        ),
      ),
    );

  const events = rows
    .map((r) => {
      // Prefer the scheduled date when set, otherwise anchor on
      // completion date for floating completions. Anything else has
      // no anchor and we skip it.
      const anchor = r.scheduledDate ?? isoDate(r.completedAt);
      if (!anchor) return null;
      const done = r.status === 'done';
      return formatVEvent({
        uid: `occ:${r.id}@family-todo`,
        title: done ? `✓ ${r.title}` : r.title,
        description: r.description ?? '',
        date: anchor,
        time: r.scheduledTime ?? null,
        completed: done,
      });
    })
    .filter((s): s is string => s !== null);

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Family Todo//RU',
    `X-WR-CALNAME:${escapeIcs(family.name)}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...events,
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

function emptyIcs(name: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Family Todo//RU',
    `X-WR-CALNAME:${escapeIcs(name)}`,
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

function formatVEvent(input: {
  uid: string;
  title: string;
  description: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM or HH:MM:SS, optional */
  time: string | null;
  /** Whether the occurrence is done — emits STATUS:COMPLETED so clients
   *  that support it can render the event differently (strikethrough,
   *  greyed out, etc.). The ✓ prefix in the SUMMARY is the universal
   *  fallback for clients that ignore STATUS. */
  completed?: boolean;
}): string {
  const dtStamp = formatDateTimeUtc(new Date());
  const [y, m, d] = input.date.split('-');
  let dtStart: string;
  let dtEnd: string;
  if (input.time) {
    const [hh, mm] = input.time.split(':');
    // Anchor in floating local time (no TZID) so the user's calendar
    // app shows it in their local clock — the family's tz on the
    // server is metadata only.
    dtStart = `${y}${m}${d}T${hh}${mm}00`;
    // 30-min default duration; aligns with typical chore window.
    const end = new Date(`${y}-${m}-${d}T${hh}:${mm}:00`);
    end.setMinutes(end.getMinutes() + 30);
    const ey = end.getFullYear();
    const em = String(end.getMonth() + 1).padStart(2, '0');
    const ed = String(end.getDate()).padStart(2, '0');
    const ehh = String(end.getHours()).padStart(2, '0');
    const emm = String(end.getMinutes()).padStart(2, '0');
    dtEnd = `${ey}${em}${ed}T${ehh}${emm}00`;
  } else {
    // All-day event: DTSTART;VALUE=DATE — DTEND is the day AFTER per RFC.
    dtStart = `${y}${m}${d}`;
    const next = new Date(`${y}-${m}-${d}T00:00:00`);
    next.setDate(next.getDate() + 1);
    dtEnd =
      `${next.getFullYear()}` +
      String(next.getMonth() + 1).padStart(2, '0') +
      String(next.getDate()).padStart(2, '0');
  }
  const dateParam = input.time ? '' : ';VALUE=DATE';
  return [
    'BEGIN:VEVENT',
    `UID:${input.uid}`,
    `DTSTAMP:${dtStamp}Z`,
    `DTSTART${dateParam}:${dtStart}`,
    `DTEND${dateParam}:${dtEnd}`,
    `SUMMARY:${escapeIcs(input.title)}`,
    ...(input.description
      ? [`DESCRIPTION:${escapeIcs(input.description)}`]
      : []),
    ...(input.completed ? ['STATUS:COMPLETED'] : []),
    'END:VEVENT',
  ].join('\r\n');
}

/** Convert a Date (or null) to YYYY-MM-DD in UTC. Returns null when the
 *  input is null — callers use this to anchor floating completions on
 *  their completedAt timestamp. UTC keeps the anchor stable regardless
 *  of the server's local clock, mirroring how `scheduledDate` (stored
 *  as a bare `date`) is treated. */
function isoDate(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

function formatDateTimeUtc(d: Date): string {
  return (
    d.getUTCFullYear().toString() +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0') +
    'T' +
    String(d.getUTCHours()).padStart(2, '0') +
    String(d.getUTCMinutes()).padStart(2, '0') +
    String(d.getUTCSeconds()).padStart(2, '0')
  );
}

function escapeIcs(s: string): string {
  // RFC 5545 §3.3.11: backslash, semicolon, comma, newline need escaping.
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\n|\r/g, '\\n');
}
