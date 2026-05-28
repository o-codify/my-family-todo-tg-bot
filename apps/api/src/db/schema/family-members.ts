import { index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { families } from './families';
import { roles } from './roles';
import { users } from './users';

export const familyMembers = pgTable(
  'family_members',
  {
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    // Family-scoped name override set by the family owner. The user's global
    // `firstName`/`lastName` re-sync from Telegram on every auth, so a custom
    // name can't live on `users` — it would be clobbered. Null = fall back to
    // the Telegram name.
    displayName: text('display_name'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.familyId, table.userId] }),
    userIdx: index('family_members_user_idx').on(table.userId),
  }),
);

export type FamilyMemberRow = typeof familyMembers.$inferSelect;
export type NewFamilyMemberRow = typeof familyMembers.$inferInsert;
