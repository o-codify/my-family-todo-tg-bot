import { and, asc, eq, isNull } from 'drizzle-orm';
import type {
  CreateFamilyEventInput,
  FamilyEventType,
  UpdateFamilyEventInput,
} from '@family-todo/shared';
import { db } from '../db/client';
import { familyEvents, type FamilyEventRow } from '../db/schema';
import { publishFamilyEvent } from '../realtime/pubsub';

/**
 * Family events service — birthdays, anniversaries, and free-form
 * important dates. Each row stores month/day so the event recurs every
 * year; we compute "the next occurrence" on read.
 *
 * No occurrence rows — unlike tasks, events don't carry state across
 * iterations (no "complete"). One DB row → one yearly recurrence is
 * enough for everything the UI needs (upcoming list + reminders).
 */

export async function listEvents(input: {
  familyId: string;
}): Promise<FamilyEventRow[]> {
  return db
    .select()
    .from(familyEvents)
    .where(and(eq(familyEvents.familyId, input.familyId), isNull(familyEvents.deletedAt)))
    .orderBy(asc(familyEvents.month), asc(familyEvents.day));
}

export async function createEvent(input: {
  familyId: string;
  userId: string;
  data: CreateFamilyEventInput;
}): Promise<FamilyEventRow> {
  const [row] = await db
    .insert(familyEvents)
    .values({
      familyId: input.familyId,
      type: input.data.type,
      title: input.data.title,
      emoji: input.data.emoji ?? null,
      month: input.data.month,
      day: input.data.day,
      year: input.data.year ?? null,
      memberUserId: input.data.memberUserId ?? null,
      notifyDaysBefore: input.data.notifyDaysBefore ?? [0, 1, 7],
      createdByUserId: input.userId,
    })
    .returning();
  void publishFamilyEvent(input.familyId, { kind: 'invalidate', scope: 'events' });
  return row!;
}

export async function updateEvent(input: {
  familyId: string;
  eventId: string;
  patch: UpdateFamilyEventInput;
}): Promise<FamilyEventRow | null> {
  const next: Partial<typeof familyEvents.$inferInsert> = {};
  if (input.patch.type !== undefined) next.type = input.patch.type;
  if (input.patch.title !== undefined) next.title = input.patch.title;
  if (input.patch.emoji !== undefined) next.emoji = input.patch.emoji;
  if (input.patch.month !== undefined) next.month = input.patch.month;
  if (input.patch.day !== undefined) next.day = input.patch.day;
  if (input.patch.year !== undefined) next.year = input.patch.year;
  if (input.patch.memberUserId !== undefined) {
    next.memberUserId = input.patch.memberUserId;
  }
  if (input.patch.notifyDaysBefore !== undefined) {
    next.notifyDaysBefore = input.patch.notifyDaysBefore;
  }
  if (Object.keys(next).length === 0) {
    const existing = await db.query.familyEvents.findFirst({
      where: eq(familyEvents.id, input.eventId),
    });
    return existing ?? null;
  }
  next.updatedAt = new Date();
  const [row] = await db
    .update(familyEvents)
    .set(next)
    .where(eq(familyEvents.id, input.eventId))
    .returning();
  if (row) void publishFamilyEvent(input.familyId, { kind: 'invalidate', scope: 'events' });
  return row ?? null;
}

export async function deleteEvent(input: {
  familyId: string;
  eventId: string;
}): Promise<boolean> {
  const res = await db
    .update(familyEvents)
    .set({ deletedAt: new Date() })
    .where(and(eq(familyEvents.id, input.eventId), isNull(familyEvents.deletedAt)))
    .returning({ id: familyEvents.id });
  if (res.length > 0) {
    void publishFamilyEvent(input.familyId, { kind: 'invalidate', scope: 'events' });
  }
  return res.length > 0;
}

export async function restoreEvent(input: {
  familyId: string;
  eventId: string;
}): Promise<FamilyEventRow | null> {
  const [row] = await db
    .update(familyEvents)
    .set({ deletedAt: null })
    .where(eq(familyEvents.id, input.eventId))
    .returning();
  if (row) void publishFamilyEvent(input.familyId, { kind: 'invalidate', scope: 'events' });
  return row ?? null;
}

/**
 * Compute the next occurrence of (month, day) on/after `today` (UTC date).
 * Handles Feb 29 by shifting to Feb 28 in non-leap years. Returns the
 * Date at midnight UTC of the event day.
 */
export function nextOccurrence(
  month: number,
  day: number,
  today: Date = new Date(),
): Date {
  const year = today.getUTCFullYear();
  const candidate = makeDate(year, month, day);
  // If the event has already passed this year, move to next year.
  const todayUtc = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  if (candidate.getTime() < todayUtc) {
    return makeDate(year + 1, month, day);
  }
  return candidate;
}

function makeDate(year: number, month: number, day: number): Date {
  // Feb 29 in a non-leap year → fall back to Feb 28. Anything else
  // out-of-range is the user's input and we trust the validation.
  if (month === 2 && day === 29 && !isLeap(year)) {
    return new Date(Date.UTC(year, 1, 28));
  }
  return new Date(Date.UTC(year, month - 1, day));
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysUntil(month: number, day: number, today: Date = new Date()): number {
  const next = nextOccurrence(month, day, today);
  const startOfToday = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  return Math.round((next.getTime() - startOfToday) / 86_400_000);
}

/** Age the person would be at the next occurrence (null when year unknown). */
export function ageAtNextOccurrence(
  birthYear: number | null,
  month: number,
  day: number,
  today: Date = new Date(),
): number | null {
  if (birthYear === null) return null;
  const next = nextOccurrence(month, day, today);
  return next.getUTCFullYear() - birthYear;
}

export function serializeFamilyEvent(row: FamilyEventRow) {
  return {
    id: row.id,
    familyId: row.familyId,
    type: row.type as FamilyEventType,
    title: row.title,
    emoji: row.emoji,
    month: row.month,
    day: row.day,
    year: row.year,
    memberUserId: row.memberUserId,
    notifyDaysBefore: row.notifyDaysBefore,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
