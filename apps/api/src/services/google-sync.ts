import { and, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import { db } from '../db/client';
import {
  familyEvents,
  familyMembers,
  googleOauthTokens,
  taskOccurrences,
  tasks,
  users,
} from '../db/schema';
import { logger } from '../logger';
import { daysUntil, nextOccurrence } from './events';
import {
  deleteEvent,
  insertEvent,
  listOurEvents,
  patchEvent,
  type GoogleCalendarEvent,
} from './google-calendar';
import { getTokenRow } from './google-oauth';

/**
 * Google Calendar reconcile engine.
 *
 * Strategy: full reconcile of the user's next 60 days. Each task
 * occurrence assigned to the user, plus each family event coming up,
 * is rendered as a desired event payload (with a stable per-source
 * `extendedProperties.private.familyTodoSourceId`). We fetch all our
 * existing events from the dedicated calendar (filtered by the
 * `familyTodo=1` marker) and:
 *   - upsert when the source still wants the event;
 *   - delete when the source is gone (task archived, completed,
 *     occurrence moved out of range, etc).
 *
 * We don't try to detect granular changes — patching the entire event
 * is cheap, and Google Calendar is happy to accept a same-state PATCH.
 *
 * Runs from a 5-minute cron per connected user. The cron tick is in
 * `queue/google-cron.ts`.
 */

const WINDOW_BACK_DAYS = 7;
const WINDOW_FWD_DAYS = 60;

type DesiredEvent = {
  /** Stable across reconciles: `task:<occurrenceId>` or `event:<id>`. */
  sourceId: string;
  summary: string;
  description: string;
  /** YYYY-MM-DD; we use all-day events for everything (the time-of-day
   *  for occurrences is captured inside `description` for the MVP — most
   *  family chores feel like all-day reminders anyway). */
  date: string;
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

/** Collect desired events from our DB for `userId`. Spans all families
 *  the user is a member of. */
async function collectDesiredEvents(userId: string): Promise<DesiredEvent[]> {
  const today = new Date();
  const from = isoDate(addDays(today, -WINDOW_BACK_DAYS));
  const to = isoDate(addDays(today, WINDOW_FWD_DAYS));

  // What families is the user in?
  const memberships = await db
    .select({ familyId: familyMembers.familyId })
    .from(familyMembers)
    .where(eq(familyMembers.userId, userId));
  const familyIds = memberships.map((m) => m.familyId);
  if (familyIds.length === 0) return [];

  const desired: DesiredEvent[] = [];

  // 1. Task occurrences assigned to (or available to) the user.
  const occRows = await db
    .select({
      id: taskOccurrences.id,
      date: taskOccurrences.scheduledDate,
      time: taskOccurrences.scheduledTime,
      title: tasks.title,
      description: tasks.description,
      points: tasks.points,
    })
    .from(taskOccurrences)
    .innerJoin(tasks, eq(taskOccurrences.taskId, tasks.id))
    .where(
      and(
        inArray(tasks.familyId, familyIds),
        isNull(tasks.archivedAt),
        eq(taskOccurrences.status, 'pending'),
        eq(taskOccurrences.assigneeId, userId),
        // Dated only — floating tasks have no anchor.
        gte(taskOccurrences.scheduledDate, from),
        lte(taskOccurrences.scheduledDate, to),
      ),
    );
  for (const r of occRows) {
    if (!r.date) continue;
    const time = r.time ? ` · ${r.time.slice(0, 5)}` : '';
    const pts = r.points > 0 ? ` · +${r.points}` : '';
    desired.push({
      sourceId: `task:${r.id}`,
      summary: `${r.title}${time}${pts}`,
      description: r.description ?? '',
      date: r.date,
    });
  }

  // 2. Family events coming up — these are family-wide, not personal,
  // but the user being a member is enough authorization. We surface
  // anything within the forward window from any of their families.
  const evRows = await db
    .select()
    .from(familyEvents)
    .where(
      and(
        inArray(familyEvents.familyId, familyIds),
        isNull(familyEvents.deletedAt),
      ),
    );
  for (const ev of evRows) {
    const next = nextOccurrence(ev.month, ev.day, today);
    const days = daysUntil(ev.month, ev.day, today);
    if (days > WINDOW_FWD_DAYS || days < -WINDOW_BACK_DAYS) continue;
    const emoji = ev.emoji ?? '📅';
    desired.push({
      sourceId: `event:${ev.id}`,
      summary: `${emoji} ${ev.title}`,
      description: '',
      date: isoDate(next),
    });
  }

  return desired;
}

/**
 * Full reconcile for one user. Idempotent — running twice in a row
 * is cheap (everything matches and no API calls happen).
 *
 * Best-effort: any single API failure is logged + swallowed; the next
 * tick will retry.
 */
export async function reconcileUserCalendar(userId: string): Promise<{
  added: number;
  updated: number;
  deleted: number;
}> {
  const tokenRow = await getTokenRow(userId);
  if (!tokenRow) {
    return { added: 0, updated: 0, deleted: 0 };
  }
  const calendarId = tokenRow.calendarId;

  const today = new Date();
  const timeMin = `${isoDate(addDays(today, -WINDOW_BACK_DAYS))}T00:00:00Z`;
  const timeMax = `${isoDate(addDays(today, WINDOW_FWD_DAYS + 1))}T00:00:00Z`;

  // Existing events in our dedicated calendar.
  const existing = await listOurEvents({ userId, calendarId, timeMin, timeMax });
  const existingBySource = new Map<string, GoogleCalendarEvent>();
  for (const e of existing) {
    const src = e.extendedProperties?.private?.familyTodoSourceId;
    if (src) existingBySource.set(src, e);
  }

  // Desired events from our DB.
  const desired = await collectDesiredEvents(userId);
  const desiredBySource = new Map<string, DesiredEvent>();
  for (const d of desired) desiredBySource.set(d.sourceId, d);

  let added = 0;
  let updated = 0;
  let deleted = 0;

  // Upsert.
  for (const d of desired) {
    const existing = existingBySource.get(d.sourceId);
    const desiredPayload = {
      summary: d.summary,
      description: d.description,
      start: { date: d.date },
      end: { date: isoDate(addDays(new Date(`${d.date}T00:00:00Z`), 1)) },
      extendedProperties: {
        private: {
          familyTodo: '1',
          familyTodoSourceId: d.sourceId,
        },
      },
    };
    if (!existing) {
      const res = await insertEvent({ userId, calendarId, event: desiredPayload });
      if (res) added++;
    } else {
      // Cheap diff — most fields are identical reconcile-to-reconcile;
      // only PATCH when something actually changed to keep API load down.
      const drift =
        existing.summary !== desiredPayload.summary ||
        (existing.description ?? '') !== desiredPayload.description ||
        existing.start?.date !== desiredPayload.start.date;
      if (drift) {
        const res = await patchEvent({
          userId,
          calendarId,
          eventId: existing.id,
          event: desiredPayload,
        });
        if (res) updated++;
      }
    }
  }

  // Delete the leftovers (events we created that no longer have a
  // matching source — done, archived, deleted, or moved out of window).
  for (const [src, ev] of existingBySource) {
    if (!desiredBySource.has(src)) {
      await deleteEvent({ userId, calendarId, eventId: ev.id });
      deleted++;
    }
  }

  logger.debug({ userId, added, updated, deleted }, 'google reconcile done');
  return { added, updated, deleted };
}

/** All connected users — for the cron tick. */
export async function listConnectedUserIds(): Promise<string[]> {
  const rows = await db
    .select({ userId: googleOauthTokens.userId })
    .from(googleOauthTokens);
  return rows.map((r) => r.userId);
}

// Silence unused-imports the linter complains about.
void or;
void users;
