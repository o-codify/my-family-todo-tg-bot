import { sql } from 'drizzle-orm';
import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { families } from './families';
import { tasks } from './tasks';

/**
 * Per-family labels users can attach to tasks. Each family owns its own
 * set of tags — there's no global taxonomy. A tag has a short label and
 * an optional colour so chips read at a glance ("кухня" / "школа" /
 * "машина"). Names are unique per-family, case-insensitive.
 */
export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Hex colour (`#rrggbb`). Optional — UI falls back to a neutral pill. */
    color: text('color'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyIdx: index('tags_family_idx').on(table.familyId),
    familyNameUnique: uniqueIndex('tags_family_name_unique').on(
      table.familyId,
      sql`lower(${table.name})`,
    ),
  }),
);

export type TagRow = typeof tags.$inferSelect;
export type NewTagRow = typeof tags.$inferInsert;

/**
 * Many-to-many join between tasks and tags. Cascade on both sides — if
 * a task or tag is deleted the join rows go with it. Composite primary
 * key (taskId, tagId) doubles as the uniqueness guard so the same tag
 * can't be attached twice to one task.
 */
export const taskTags = pgTable(
  'task_tags',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.taskId, table.tagId] }),
    tagIdx: index('task_tags_tag_idx').on(table.tagId),
  }),
);

export type TaskTagRow = typeof taskTags.$inferSelect;
