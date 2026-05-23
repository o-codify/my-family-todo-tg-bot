import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { families } from './families';
import { users } from './users';

/**
 * Long-lived per-(user, family) tokens for ICS feed subscription.
 * Google/Apple Calendar fetch the URL on their own schedule; they
 * can't send a Telegram initData header, so the token in the URL is
 * the auth boundary. Treat it as a secret — revealed via "Copy URL"
 * once, revocable from the UI.
 *
 * One active token per (user, family). Re-issuing rotates: we keep
 * the old row with revokedAt set so audit + restore are trivial.
 */
export const icsTokens = pgTable(
  'ics_tokens',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** Random base32-ish string; 32 chars from a 32-char alphabet ≈
     *  160 bits of entropy. Lookup is by exact-match. */
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => ({
    userFamilyIdx: index('ics_tokens_user_family_idx').on(
      table.userId,
      table.familyId,
    ),
  }),
);

export type IcsTokenRow = typeof icsTokens.$inferSelect;
export type NewIcsTokenRow = typeof icsTokens.$inferInsert;
