import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { families } from './families';
import { users } from './users';

/**
 * Family events — birthdays, anniversaries, name days, memorial dates,
 * and free-form "important dates".
 *
 * Stored as a (month, day) pair rather than a full date because all of
 * these are yearly-recurring: we need to compute "next occurrence" on the
 * fly, not store one fixed timestamp. `year` is optional and used only
 * for age display ("исполняется 30") — when null we just show the day.
 *
 * `memberUserId` links the event to a family member when it is THEIR
 * birthday (so we can render avatar/color from the user). Standalone
 * events (e.g. anniversary, holiday reminder) leave it null and the
 * title carries the meaning.
 *
 * `notifyDaysBefore` is an array of days (0 = day-of, 1 = "tomorrow",
 * 7 = "in a week"). The digest worker / on-load card check this list
 * against `(today, eventDate)` to decide whether to surface the event.
 *
 * Soft-deleted via `deletedAt` so an "Отменить" toast can restore.
 */
export const familyEvents = pgTable(
  'family_events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** 'birthday' | 'anniversary' | 'nameday' | 'memorial' | 'custom' */
    type: text('type').notNull(),
    /** Short display label. For member birthdays we still store the
     *  name so we can render the row even if the membership is gone. */
    title: text('title').notNull(),
    /** Emoji shown as the avatar/icon. Optional — falls back per type. */
    emoji: text('emoji'),
    /** 1–12 */
    month: integer('month').notNull(),
    /** 1–31. Feb 29 events shift to Feb 28 in non-leap years (client logic). */
    day: integer('day').notNull(),
    /** Optional birth year / start year, used for age display. */
    year: integer('year'),
    memberUserId: uuid('member_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Array of day offsets to notify on. Empty = no reminders. */
    notifyDaysBefore: jsonb('notify_days_before')
      .$type<number[]>()
      .notNull()
      .default([0, 1, 7]),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    familyIdx: index('family_events_family_idx').on(table.familyId),
    memberIdx: index('family_events_member_idx').on(table.memberUserId),
  }),
);

export type FamilyEventRow = typeof familyEvents.$inferSelect;
export type NewFamilyEventRow = typeof familyEvents.$inferInsert;

export const FAMILY_EVENT_TYPES = [
  'birthday',
  'anniversary',
  'nameday',
  'memorial',
  'custom',
] as const;
export type FamilyEventType = (typeof FAMILY_EVENT_TYPES)[number];
