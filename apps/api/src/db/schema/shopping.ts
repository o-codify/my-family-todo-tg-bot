import { sql } from 'drizzle-orm';
import {
  date as pgDate,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { catalogItems } from './catalog';
import { families } from './families';
import { users } from './users';

/**
 * Shopping lists — multiple per family, each with an optional assignee
 * (the person responsible for buying) and an optional dueDate (when
 * set, a one-off task wrapper is created so the list shows up on the
 * calendar). Catalog acts as the family's master goods directory;
 * individual list items may link to a catalog row via
 * `shoppingItems.catalogItemId`, or be free-text (which auto-adds to
 * the catalog on insert).
 *
 * Soft-archival via `archivedAt`. There's no longer a "primary"
 * concept — the page surfaces a list-of-lists with create/move actions.
 */
export const shoppingLists = pgTable(
  'shopping_lists',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Person responsible for buying. Null = unassigned. */
    assigneeUserId: uuid('assignee_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Optional deadline. When set, a one-off backing task is created
     *  with this date so the list lands on the family calendar. */
    dueDate: pgDate('due_date', { mode: 'string' }),
    /** Backing task id created when `dueDate` is set. Null when the
     *  list is dateless. The task is deleted/archived together with
     *  the list. */
    taskId: uuid('task_id'),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyIdx: index('shopping_lists_family_idx').on(table.familyId),
    taskIdx: index('shopping_lists_task_idx').on(table.taskId),
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
    /** Optional canonical entry in the family catalog. When set, the
     *  row "is" that catalog item — same name/emoji. Free-text items
     *  leave this null; the service still auto-creates a catalog row
     *  for them and links it, so over time everything becomes catalog
     *  -backed and the picker has fewer duplicates. */
    catalogItemId: uuid('catalog_item_id').references(() => catalogItems.id, {
      onDelete: 'set null',
    }),
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
