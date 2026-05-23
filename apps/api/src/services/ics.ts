import { customAlphabet } from 'nanoid';
import { and, eq, gte, isNull, lte, or } from 'drizzle-orm';
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
 * Generate a personal ICS document. Mirrors the in-app calendar query
 * (see `listFamilyOccurrences`) so every occurrence the user sees in
 * the app shows up in their subscribed calendar.
 *
 * Per-user scope:
 *   - `userId` comes from the token. We include occurrences assigned to
 *     this user PLUS unassigned occurrences (shared/anyone tasks the
 *     in-app calendar shows to everyone). Other people's personal
 *     assignments are hidden — this is a personal feed.
 *
 * Status handling — all statuses are included, but each is rendered
 * differently so a glance at the calendar shows what state the task
 * is in:
 *   - pending           → plain title
 *   - done              → "✓ Title" + STATUS:COMPLETED (strike-through
 *                         in capable clients)
 *   - pending_approval  → "⏳ Title" + STATUS:TENTATIVE (greyed out)
 *   - skipped / expired → "⊘ Title" + STATUS:CANCELLED (struck-through)
 *
 * Date handling:
 *   - Dated rows inside ±window appear on their scheduled date.
 *   - Done dateless rows (typical for singleShot floating completions)
 *     are anchored on `completedAt` — without this they'd be invisible.
 *   - Pending dateless rows (the "Когда-нибудь" / queued backlog the
 *     in-app calendar pins to today) are anchored on the current day
 *     as all-day events. Apple/Google don't have a "no date" bucket
 *     so this is the closest analogue.
 *
 * Window: 90 days back, 365 forward. Calendar apps cache aggressively;
 * we err wide so a once-a-day fetch covers the next year.
 *
 * Output uses CRLF per RFC 5545. We don't fold lines (the RFC asks for
 * ≤75 octets per line) — modern parsers accept unfolded lines and our
 * titles are usually short.
 */
export async function generateFamilyIcs(input: {
  familyId: string;
  /** Token-owning user. Filters occurrences to "mine + unassigned". */
  userId: string;
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
  const todayIso = today.toISOString().slice(0, 10);

  const rows = await db
    .select({
      id: taskOccurrences.id,
      scheduledDate: taskOccurrences.scheduledDate,
      scheduledTime: taskOccurrences.scheduledTime,
      status: taskOccurrences.status,
      completedAt: taskOccurrences.completedAt,
      assigneeId: taskOccurrences.assigneeId,
      title: tasks.title,
      description: tasks.description,
    })
    .from(taskOccurrences)
    .innerJoin(tasks, eq(taskOccurrences.taskId, tasks.id))
    .where(
      and(
        eq(tasks.familyId, input.familyId),
        isNull(tasks.archivedAt),
        // Personal feed: my tasks + unassigned (shared) tasks. Skip
        // occurrences explicitly assigned to other family members.
        or(
          eq(taskOccurrences.assigneeId, input.userId),
          isNull(taskOccurrences.assigneeId),
        ),
        or(
          // Dated rows inside the visible window — any status.
          and(
            gte(taskOccurrences.scheduledDate, from),
            lte(taskOccurrences.scheduledDate, to),
          ),
          // Dateless pending (queued/"Когда-нибудь") — always include.
          // We pin them to today as all-day below.
          and(
            isNull(taskOccurrences.scheduledDate),
            eq(taskOccurrences.status, 'pending'),
          ),
          // Dateless done (floating completion) inside completion window.
          and(
            isNull(taskOccurrences.scheduledDate),
            eq(taskOccurrences.status, 'done'),
            gte(taskOccurrences.completedAt, completedFrom),
          ),
        ),
      ),
    );

  const events = rows
    .map((r) => {
      // Pick the anchor: scheduled date wins; otherwise completedAt for
      // done rows; otherwise today for pending dateless ("Когда-нибудь")
      // rows so they show up in the user's calendar each day.
      const anchor =
        r.scheduledDate ??
        (r.status === 'done' ? isoDate(r.completedAt) : todayIso);
      if (!anchor) return null;
      const presentation = presentStatus(r.status);
      return formatVEvent({
        uid: `occ:${r.id}@family-todo`,
        title: presentation.prefix
          ? `${presentation.prefix} ${r.title}`
          : r.title,
        description: r.description ?? '',
        date: anchor,
        time: r.scheduledTime ?? null,
        status: presentation.icsStatus,
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
  /** Optional RFC 5545 STATUS property value (CONFIRMED / TENTATIVE /
   *  CANCELLED / COMPLETED). When set, capable clients render the
   *  event differently (strikethrough for COMPLETED/CANCELLED, greyed
   *  out for TENTATIVE). The SUMMARY prefix is the universal fallback
   *  for clients that ignore STATUS. */
  status?: 'COMPLETED' | 'TENTATIVE' | 'CANCELLED' | null;
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
    ...(input.status ? [`STATUS:${input.status}`] : []),
    'END:VEVENT',
  ].join('\r\n');
}

/** Map our internal occurrence status to (a) a SUMMARY prefix that
 *  works in every client, and (b) an RFC 5545 STATUS value (or null
 *  when the default CONFIRMED is fine). Keeping this in one function
 *  means a glance at the calendar tells you the task state without
 *  having to inspect each event. */
function presentStatus(status: string): {
  prefix: string | null;
  icsStatus: 'COMPLETED' | 'TENTATIVE' | 'CANCELLED' | null;
} {
  switch (status) {
    case 'done':
      return { prefix: '✓', icsStatus: 'COMPLETED' };
    case 'pending_approval':
      // Hourglass = "waiting on approval". TENTATIVE makes most
      // clients render the event greyed out.
      return { prefix: '⏳', icsStatus: 'TENTATIVE' };
    case 'skipped':
    case 'expired':
      // Slashed-zero looks like a "no" badge; CANCELLED gives strike-
      // through. We still show these so the user can see what got
      // dropped — matches the in-app calendar's behaviour.
      return { prefix: '⊘', icsStatus: 'CANCELLED' };
    case 'pending':
    default:
      return { prefix: null, icsStatus: null };
  }
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
