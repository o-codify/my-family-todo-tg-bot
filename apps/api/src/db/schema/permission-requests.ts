import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { families } from './families';
import { users } from './users';

/**
 * Free-form "ask permission" requests — a child writes "Can I play games
 * for an hour?" and a parent approves or denies. Separate from transfer
 * requests (those are task-handoffs) and reward redemptions (those
 * already exist). The MVP is intentionally text-only with a coarse
 * type tag for filtering / future bot-routing.
 *
 * Status lifecycle:
 *   pending → approved | denied (terminal)
 *   pending → cancelled (by requester, terminal)
 *
 * No retries — a denied request stays in history; the kid creates a new
 * one if they want to ask again.
 */
export const permissionRequests = pgTable(
  'permission_requests',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    requesterUserId: uuid('requester_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Coarse category — used for icons in the UI + future bot routing
     *  ("/permissions" command could pre-filter by type). */
    type: text('type').notNull().default('other'),
    text: text('text').notNull(),
    /** 'pending' | 'approved' | 'denied' | 'cancelled' */
    status: text('status').notNull().default('pending'),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionReason: text('decision_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyStatusIdx: index('permission_requests_family_status_idx').on(
      table.familyId,
      table.status,
    ),
    requesterIdx: index('permission_requests_requester_idx').on(table.requesterUserId),
  }),
);

export type PermissionRequestRow = typeof permissionRequests.$inferSelect;
export type NewPermissionRequestRow = typeof permissionRequests.$inferInsert;

export const PERMISSION_REQUEST_TYPES = [
  'screen_time',
  'friend_visit',
  'spending',
  'food',
  'other',
] as const;
export type PermissionRequestType = (typeof PERMISSION_REQUEST_TYPES)[number];

export const PERMISSION_REQUEST_STATUSES = [
  'pending',
  'approved',
  'denied',
  'cancelled',
] as const;
export type PermissionRequestStatus = (typeof PERMISSION_REQUEST_STATUSES)[number];
