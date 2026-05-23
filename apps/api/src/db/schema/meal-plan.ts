import { sql } from 'drizzle-orm';
import {
  date as pgDate,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { families } from './families';
import { users } from './users';

/**
 * Weekly meal plan entries — one row per (date, slot). Slots are loosely
 * defined (breakfast / lunch / dinner / snack / other) so families that
 * skip a meal don't end up with phantom slots.
 *
 * Ingredients are stored as a flat JSONB array of `{ text, quantity? }`
 * so the "push to shopping list" button can pass them straight into the
 * shopping bulk-add endpoint. Category lives only on shopping items —
 * meal-plan ingredients default to 'other' when pushed, and the user
 * recategorizes once in the shopping page.
 *
 * Soft-deleted via `deletedAt` so we keep the undo pattern consistent.
 */
export const mealPlanEntries = pgTable(
  'meal_plan_entries',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** YYYY-MM-DD in the family's "calendar" timezone — same convention
     *  used by task_occurrences.scheduledDate. */
    date: pgDate('date').notNull(),
    /** 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'other' */
    slot: text('slot').notNull(),
    title: text('title').notNull(),
    notes: text('notes'),
    /** Pre-parsed ingredient list — what the user typed split by line.
     *  Each entry: `{ text: string; quantity?: string | null }`. */
    ingredients: jsonb('ingredients')
      .$type<Array<{ text: string; quantity?: string | null }>>()
      .notNull()
      .default([]),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    familyDateIdx: index('meal_plan_family_date_idx').on(table.familyId, table.date),
    // One entry per (family, date, slot) — re-using a slot replaces. We
    // don't enforce uniqueness in the DB because soft-delete creates
    // phantom rows; the service deduplicates on write.
    uniqAlive: uniqueIndex('meal_plan_family_date_slot_alive_idx')
      .on(table.familyId, table.date, table.slot)
      .where(sql`${table.deletedAt} IS NULL`),
  }),
);

export type MealPlanEntryRow = typeof mealPlanEntries.$inferSelect;
export type NewMealPlanEntryRow = typeof mealPlanEntries.$inferInsert;

export const MEAL_PLAN_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack', 'other'] as const;
export type MealPlanSlot = (typeof MEAL_PLAN_SLOTS)[number];
