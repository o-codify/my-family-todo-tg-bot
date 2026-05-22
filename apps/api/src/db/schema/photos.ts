import { sql } from 'drizzle-orm';
import { bigint, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { taskOccurrences, tasks } from './tasks';
import { users } from './users';

/**
 * Task photos — Telegram-native storage.
 *
 * Photos are NOT stored in our object storage. Instead, when a user attaches
 * a photo to a task in the Mini App, the backend sends that photo to the
 * user's private chat with the bot (caption: "Photo added to task: …",
 * inline keyboard: [Open task] [Delete photo]). Telegram returns a
 * `file_id` we keep as the canonical reference, and a `message_id` we keep
 * so we can later edit/delete the bot's chat message when the photo is
 * removed.
 *
 * For display, the backend calls `getFile` on the Bot API and exposes a
 * short-lived Telegram CDN URL to the client — we never proxy the bytes.
 */
export const taskPhotos = pgTable(
  'task_photos',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    // Which occurrence (= completion event) this photo is attached to.
    // Null is allowed for photos attached "to the task" without a completion
    // (e.g. a future "before/after" feature). Always set on completion.
    occurrenceId: uuid('occurrence_id').references(() => taskOccurrences.id, {
      onDelete: 'set null',
    }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Telegram's canonical file id. We use this to fetch a fresh CDN URL on
     *  every display via the Bot API's `getFile` endpoint. */
    telegramFileId: text('telegram_file_id').notNull(),
    /** Telegram message we sent to the user's private chat with the bot.
     *  Lets us later edit (replace inline keyboard after delete) or delete
     *  that message when the user removes the photo. */
    telegramMessageId: bigint('telegram_message_id', { mode: 'number' }),
    /** The bot's chat with this user (= user's telegram_id for private chats). */
    telegramChatId: bigint('telegram_chat_id', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    taskIdx: index('task_photos_task_idx').on(table.taskId),
    occurrenceIdx: index('task_photos_occurrence_idx').on(table.occurrenceId),
    userIdx: index('task_photos_user_idx').on(table.userId),
  }),
);

export type TaskPhotoRow = typeof taskPhotos.$inferSelect;
export type NewTaskPhotoRow = typeof taskPhotos.$inferInsert;
