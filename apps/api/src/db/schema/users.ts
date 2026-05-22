import { sql } from 'drizzle-orm';
import { bigint, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { NotificationSettings } from '@family-todo/shared';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  telegramId: bigint('telegram_id', { mode: 'bigint' }).notNull().unique(),
  username: text('username'),
  firstName: text('first_name').notNull(),
  lastName: text('last_name'),
  avatarUrl: text('avatar_url'),
  locale: text('locale').notNull().default('ru'),
  timezone: text('timezone').notNull().default('Europe/Moscow'),
  color: text('color').notNull().default('#4ECDC4'),
  notificationSettings: jsonb('notification_settings')
    .$type<NotificationSettings>()
    .notNull()
    .default({
      quietHoursStart: null,
      quietHoursEnd: null,
      digestEnabled: true,
      digestTime: '08:00',
      defaultReminderBeforeMinutes: 15,
    }),
  awayUntil: timestamp('away_until', { withTimezone: true }),
  // Why the user is away — 'vacation' (default for the existing "В отъезде"
  // toggle) or 'sick'. Both opt the user out of queue rotations equally,
  // but the UI shows different icons/labels (🌴 vs 🤒).
  awayReason: text('away_reason'),
  // Per-user client preferences that don't deserve their own column —
  // calendar view mode, viewed-tutorial flag, filter chips state, etc.
  // Schema-less JSON because each setting is small, optional, and lives
  // on the client; the server only round-trips it. Adding a new key is
  // a frontend change, not a backend one.
  preferences: jsonb('preferences').$type<UserPreferences>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Loosely-typed bag of frontend preferences. Backend treats this as opaque —
 * it just stores and returns it; the client picks the shape. Keeping it
 * here as a type so Drizzle's inferred row carries it through.
 */
export type UserPreferences = {
  viewedTutorial?: boolean;
  calendarViewMode?: 'month' | 'week' | 'agenda';
  calendarFilters?: {
    onlyMine?: boolean;
    onlyPending?: boolean;
    onlyWithPhoto?: boolean;
    tagIds?: string[];
  };
  // Free-form for future entries — keep additive, never reuse a key for
  // a different shape (would break clients that cached an older value).
  [key: string]: unknown;
};

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
