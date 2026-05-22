import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Notifications idempotency log.
 *
 * Every send by the worker checks (and creates) a row here keyed by a
 * deterministic `dedupeKey` so we never deliver the same digest/reminder
 * twice (BullMQ at-least-once semantics + restart-on-deploy = duplicate
 * deliveries without this guard). The DB unique index does the work; the
 * worker just inserts and treats a 23505 as "already delivered".
 *
 * `kind` is the job family ("digest" | "reminder" | …); kept as text so we
 * don't have to migrate the enum every time a new notification type ships.
 */
export const notificationsLog = pgTable(
  'notifications_log',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    /** Deterministic key — e.g. `digest:<userId>:2026-05-21` for digests, or
     *  `reminder:<occurrenceId>` for occurrence reminders. */
    dedupeKey: text('dedupe_key').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dedupe: uniqueIndex('notifications_log_dedupe_unique').on(t.dedupeKey),
  }),
);

export type NotificationsLogRow = typeof notificationsLog.$inferSelect;
