import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Google Calendar OAuth tokens, per user. The access token expires
 * after ~1 hour; the refresh token persists until revoked (by us or by
 * the user via Google's "Apps with account access" page).
 *
 * Both tokens are encrypted at rest with AES-256-GCM — see
 * `services/google-crypto.ts`. The DB stores the IV (12 bytes) and the
 * auth tag (16 bytes) prepended to the ciphertext, all base64.
 *
 * `calendar_id` is the id of the dedicated "Family Todo" calendar we
 * create in the user's Google account on first connect. All events
 * the sync engine writes target that calendar — never the user's
 * primary, so disconnecting + revoking the calendar removes our data
 * cleanly without touching their own entries.
 *
 * One row per user. Reconnecting overwrites in place (so we don't pile
 * up stale rows).
 */
export const googleOauthTokens = pgTable('google_oauth_tokens', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** AES-GCM ciphertext (base64). */
  accessTokenEnc: text('access_token_enc').notNull(),
  /** AES-GCM ciphertext (base64). Long-lived. */
  refreshTokenEnc: text('refresh_token_enc').notNull(),
  /** When the access token expires; we refresh ~5 min before. */
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  /** Dedicated Google Calendar id the sync engine writes to. */
  calendarId: text('calendar_id').notNull(),
  /** Space-separated scopes Google granted. */
  scope: text('scope').notNull(),
  connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type GoogleOauthTokenRow = typeof googleOauthTokens.$inferSelect;
export type NewGoogleOauthTokenRow = typeof googleOauthTokens.$inferInsert;
