import { sql } from 'drizzle-orm';
import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { families } from './families';
import { users } from './users';

/**
 * Badges users earn over time — "100 задач выполнено", "месяц без пропусков",
 * "30 фото-отчётов", etc.
 *
 * We don't store the badge catalog in the DB. The definitions live in
 * `services/badges.ts` (slug → name/desc/icon/rule), keyed by `slug`.
 * Earned-state is what gets persisted: one row per (user × family × slug),
 * with the `earnedAt` timestamp the UI uses for "new badge!" highlights.
 *
 * Family scoping matters: badges are earned inside a family ("you've done
 * 100 tasks IN THIS FAMILY"), not globally. A user can re-earn the same
 * badge in a new family they join.
 */
export const userBadges = pgTable(
  'user_badges',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** Stable identifier matching a definition in `services/badges.ts`. */
    badgeSlug: text('badge_slug').notNull(),
    earnedAt: timestamp('earned_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.familyId, table.badgeSlug] }),
    familyIdx: index('user_badges_family_idx').on(table.familyId),
    userIdx: index('user_badges_user_idx').on(table.userId),
  }),
);

export type UserBadgeRow = typeof userBadges.$inferSelect;
export type NewUserBadgeRow = typeof userBadges.$inferInsert;
