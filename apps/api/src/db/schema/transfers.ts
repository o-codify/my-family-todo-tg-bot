import { sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { families } from './families';
import { taskOccurrences } from './tasks';
import { users } from './users';

export const transferStatusEnum = pgEnum('transfer_status', [
  'pending',
  'accepted',
  'rejected',
  'expired',
  'cancelled',
]);

export const transferModeEnum = pgEnum('transfer_mode', ['plain', 'swap', 'reward']);

export type TransferReward =
  | { kind: 'money'; amount?: number; currency?: string; note?: string }
  | { kind: 'treat'; note?: string }
  | { kind: 'screen_time'; minutes?: number }
  | { kind: 'favor'; note?: string }
  | { kind: 'custom'; note?: string };

export const transferRequests = pgTable(
  'transfer_requests',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    occurrenceId: uuid('occurrence_id')
      .notNull()
      .references(() => taskOccurrences.id, { onDelete: 'cascade' }),
    fromUserId: uuid('from_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toUserId: uuid('to_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mode: transferModeEnum('mode').notNull().default('plain'),
    message: text('message'),
    swapOccurrenceIds: uuid('swap_occurrence_ids').array(),
    rewards: jsonb('rewards').$type<TransferReward[]>(),
    status: transferStatusEnum('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    toUserStatusIdx: index('transfers_to_user_status_idx').on(
      table.toUserId,
      table.status,
    ),
    occurrenceIdx: index('transfers_occurrence_idx').on(table.occurrenceId),
  }),
);

export type TransferRequestRow = typeof transferRequests.$inferSelect;
