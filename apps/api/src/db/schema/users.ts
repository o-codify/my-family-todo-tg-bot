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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
