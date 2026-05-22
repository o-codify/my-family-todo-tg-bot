import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { families } from './families';
import { users } from './users';

export const redemptionStatusEnum = pgEnum('redemption_status', [
  'pending',
  'granted',
  'rejected',
]);

export const pointsLedgerReasonEnum = pgEnum('points_ledger_reason', [
  'task_completed',
  'reward_redeemed',
  'manual_adjustment',
  'streak_bonus',
]);

export const rewards = pgTable('rewards', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  familyId: uuid('family_id')
    .notNull()
    .references(() => families.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  emoji: text('emoji'),
  description: text('description'),
  costPoints: integer('cost_points').notNull(),
  availableForUserIds: uuid('available_for_user_ids').array(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type RewardRow = typeof rewards.$inferSelect;
export type NewRewardRow = typeof rewards.$inferInsert;

export const rewardRedemptions = pgTable(
  'reward_redemptions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    rewardId: uuid('reward_id').references(() => rewards.id, { onDelete: 'set null' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    costPoints: integer('cost_points').notNull(),
    status: redemptionStatusEnum('status').notNull().default('pending'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    grantedAt: timestamp('granted_at', { withTimezone: true }),
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => ({
    familyStatusIdx: index('redemptions_family_status_idx').on(table.familyId, table.status),
    userIdx: index('redemptions_user_idx').on(table.userId),
  }),
);

export type RedemptionRow = typeof rewardRedemptions.$inferSelect;

export const pointsLedger = pgTable(
  'points_ledger',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    delta: integer('delta').notNull(),
    reason: pointsLedgerReasonEnum('reason').notNull(),
    refId: uuid('ref_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCreatedIdx: index('points_ledger_user_created_idx').on(
      table.userId,
      table.createdAt,
    ),
    familyCreatedIdx: index('points_ledger_family_created_idx').on(
      table.familyId,
      table.createdAt,
    ),
  }),
);

export type PointsLedgerRow = typeof pointsLedger.$inferSelect;
