import { customAlphabet } from 'nanoid';
import { and, eq, gte, isNull, lte } from 'drizzle-orm';
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
 * Generate an ICS document for the family's upcoming occurrences.
 * Scope:
 *   - Pending (not done/skipped/etc) occurrences only — completed
 *     events would litter a subscribed calendar with stale entries.
 *   - 90 days back, 365 days forward — calendar apps cache; we err
 *     wide so a once-a-day fetch sees the next year of events.
 *   - Dateless floating tasks excluded — they have no anchor.
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

  const rows = await db
    .select({
      id: taskOccurrences.id,
      scheduledDate: taskOccurrences.scheduledDate,
      scheduledTime: taskOccurrences.scheduledTime,
      status: taskOccurrences.status,
      title: tasks.title,
      description: tasks.description,
    })
    .from(taskOccurrences)
    .innerJoin(tasks, eq(taskOccurrences.taskId, tasks.id))
    .where(
      and(
        eq(tasks.familyId, input.familyId),
        isNull(tasks.archivedAt),
        eq(taskOccurrences.status, 'pending'),
        gte(taskOccurrences.scheduledDate, from),
        lte(taskOccurrences.scheduledDate, to),
      ),
    );

  const events = rows
    .filter((r) => r.scheduledDate)
    .map((r) => formatVEvent({
      uid: `occ:${r.id}@family-todo`,
      title: r.title,
      description: r.description ?? '',
      date: r.scheduledDate!,
      time: r.scheduledTime ?? null,
    }));

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
    'END:VEVENT',
  ].join('\r\n');
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
