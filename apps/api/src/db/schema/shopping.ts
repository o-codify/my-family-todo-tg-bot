import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { families } from './families';
import { users } from './users';

/**
 * Shared shopping list per family.
 *
 * Most families keep one running list — "primary" — so we always have a
 * default; the row gets seeded lazily the first time someone opens the
 * list page. The `archivedAt` column lets the family snapshot/archive a
 * full list (e.g. "January 2026 list") and start fresh, without
 * deleting historical items.
 */
export const shoppingLists = pgTable(
  'shopping_lists',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** When true, this is the family's default running list. Exactly one
     *  list per family should have this set. New families get one
     *  auto-created lazily on first view. */
    isPrimary: text('is_primary').notNull().default('false'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyIdx: index('shopping_lists_family_idx').on(table.familyId),
  }),
);

export type ShoppingListRow = typeof shoppingLists.$inferSelect;
export type NewShoppingListRow = typeof shoppingLists.$inferInsert;

/**
 * Individual line item on a list. Status is either 'open' (still need
 * to buy) or 'bought' (someone picked it up). We track who marked it
 * so the UI can render "Аня купила" next to bought items.
 *
 * Categories are a fixed enum stored as `text` — dairy, produce, etc.
 * The UI groups items by category for the buyer's grocery-aisle scan.
 * Adding a category is a code change (i18n labels), not a migration.
 *
 * Soft-deleted via `deletedAt` so an "Отменить" toast can restore (same
 * pattern as tasks).
 */
export const shoppingItems = pgTable(
  'shopping_items',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    listId: uuid('list_id')
      .notNull()
      .references(() => shoppingLists.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    quantity: text('quantity'), // freeform: "2 шт", "500 г", null
    category: text('category').notNull().default('other'),
    status: text('status').notNull().default('open'), // 'open' | 'bought'
    assignedUserId: uuid('assigned_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    boughtByUserId: uuid('bought_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    boughtAt: timestamp('bought_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    listIdx: index('shopping_items_list_idx').on(table.listId),
    listStatusIdx: index('shopping_items_list_status_idx').on(table.listId, table.status),
  }),
);

export type ShoppingItemRow = typeof shoppingItems.$inferSelect;
export type NewShoppingItemRow = typeof shoppingItems.$inferInsert;

/** Hardcoded category enum. Adding a category = add to this list +
 *  add i18n labels in the miniapp. Backend stores the raw key. */
export const SHOPPING_CATEGORIES = [
  'dairy',
  'produce',
  'meat',
  'bakery',
  'household',
  'drinks',
  'frozen',
  'other',
] as const;
export type ShoppingCategory = (typeof SHOPPING_CATEGORIES)[number];
