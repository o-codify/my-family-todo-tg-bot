import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tasks } from './tasks';
import { users } from './users';

/**
 * Task comments — a tiny thread per task. Used for "did you do X?" /
 * "yes, photo above" back-and-forth without spinning up a full messenger.
 *
 * Soft-deleted via deletedAt so an undo works; tombstone shows
 * "comment deleted" in the UI rather than vanishing entirely (so reply
 * context stays meaningful).
 */
export const taskComments = pgTable(
  'task_comments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    taskIdx: index('task_comments_task_idx').on(table.taskId, table.createdAt),
  }),
);

export type TaskCommentRow = typeof taskComments.$inferSelect;
export type NewTaskCommentRow = typeof taskComments.$inferInsert;
