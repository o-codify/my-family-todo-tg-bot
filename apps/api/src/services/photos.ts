import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  taskPhotos,
  tasks,
  users,
  type TaskPhotoRow,
  type TaskRow,
} from '../db/schema';
import { env } from '../env';
import { logger } from '../logger';

/**
 * Telegram-native photo service.
 *
 * Lifecycle:
 *  1. `sendTaskPhoto`: API receives bytes from the Mini App → re-uploads to
 *     Telegram Bot API `sendPhoto` against the user's private chat → keeps
 *     `file_id` + `message_id` in our DB. Telegram is the source of truth.
 *  2. `getPhotoDownloadUrl`: client wants to display → API calls `getFile` →
 *     returns the short-lived Telegram CDN URL. We never proxy bytes ourselves.
 *  3. `deletePhoto`: API removes the DB row → tries to `deleteMessage` on the
 *     user's chat so the photo disappears there too (best effort).
 *
 * The `Open task` and `Delete photo` inline buttons under each photo message
 * are configured here too — clicking them goes back to the bot, which calls
 * our internal endpoint to act on the photo.
 */

const TG_API = (method: string) =>
  `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;

const TG_FILE = (path: string) =>
  `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`;

export class PhotoServiceError extends Error {
  constructor(
    public readonly code:
      | 'tg_send_failed'
      | 'tg_getfile_failed'
      | 'tg_chat_unavailable'
      | 'photo_not_found'
      | 'task_not_found'
      | 'limit_reached'
      | 'invalid_image',
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'PhotoServiceError';
  }
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

async function tgCall<T>(method: string, body: FormData | object): Promise<T> {
  const init: RequestInit =
    body instanceof FormData
      ? { method: 'POST', body }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        };
  const res = await fetch(TG_API(method), init);
  const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!json.ok) {
    logger.warn({ method, status: res.status, description: json.description }, 'Telegram API call failed');
    throw new PhotoServiceError(
      method === 'sendPhoto'
        ? 'tg_send_failed'
        : method === 'getFile'
          ? 'tg_getfile_failed'
          : 'tg_send_failed',
      json.description ?? `Telegram ${method} failed`,
    );
  }
  return json.result as T;
}

type SendPhotoResult = {
  message_id: number;
  chat: { id: number };
  photo: Array<{ file_id: string; file_size?: number; width: number; height: number }>;
};

type GetFileResult = {
  file_id: string;
  file_path?: string;
  file_size?: number;
};

// ─── Public service ────────────────────────────────────────────────────────

/**
 * Upload a photo for a task completion to the user's private chat with the
 * bot. Returns the persisted DB row.
 *
 * Throws PhotoServiceError if Telegram rejects (e.g. the user hasn't
 * started the bot yet, or the bot is blocked).
 */
export async function sendTaskPhoto(input: {
  task: TaskRow;
  occurrenceId: string | null;
  userId: string;
  fileBytes: Uint8Array;
  fileName: string;
  mimeType: string;
}): Promise<TaskPhotoRow> {
  const { task, occurrenceId, userId, fileBytes, fileName, mimeType } = input;

  // Cap photos per occurrence so a user can't spam-upload.
  if (occurrenceId) {
    const existing = await db
      .select({ id: taskPhotos.id })
      .from(taskPhotos)
      .where(eq(taskPhotos.occurrenceId, occurrenceId));
    if (existing.length >= env.PHOTO_MAX_COUNT_PER_OCCURRENCE) {
      throw new PhotoServiceError(
        'limit_reached',
        `Max ${env.PHOTO_MAX_COUNT_PER_OCCURRENCE} photos per task completion`,
      );
    }
  }

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new PhotoServiceError('tg_chat_unavailable', 'user not found');

  // The "chat id" for a private chat with the bot IS the user's telegram_id.
  // This requires the user to have run /start at least once.
  const chatId = Number(user.telegramId);

  const caption = `📸 Фото добавлено к задаче: «${task.title}»`;

  // sendPhoto expects multipart/form-data when uploading raw bytes.
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  form.append(
    'photo',
    new Blob([fileBytes], { type: mimeType }),
    fileName || 'photo.jpg',
  );

  // We can't attach the photo id to the callback button before insertion
  // (chicken-and-egg). Send first without keyboard, insert row, then edit
  // the message to add the keyboard with our photo_id baked in.
  let sent: SendPhotoResult;
  try {
    sent = await tgCall<SendPhotoResult>('sendPhoto', form);
  } catch (err) {
    if (err instanceof PhotoServiceError) throw err;
    throw new PhotoServiceError('tg_send_failed', (err as Error).message);
  }

  // Telegram returns multiple photo sizes — biggest is last.
  const biggest = sent.photo[sent.photo.length - 1];
  if (!biggest) {
    throw new PhotoServiceError('tg_send_failed', 'Telegram returned no photo sizes');
  }

  const [row] = await db
    .insert(taskPhotos)
    .values({
      taskId: task.id,
      occurrenceId,
      userId,
      telegramFileId: biggest.file_id,
      telegramMessageId: sent.message_id,
      telegramChatId: sent.chat.id,
    })
    .returning();

  // Best-effort: edit the chat message to add the action buttons. We must do
  // this AFTER insertion because we want our `row.id` in callback_data.
  // Failure here is non-fatal — the photo is already saved.
  void editKeyboard(row!, task).catch((err) => {
    logger.warn({ err, photoId: row!.id }, 'Failed to attach inline keyboard');
  });

  return row!;
}

/**
 * Decorate the just-sent photo message with [Open task] [Delete photo] buttons.
 * Called from `sendTaskPhoto` after we know the photo_id.
 */
async function editKeyboard(row: TaskPhotoRow, task: TaskRow): Promise<void> {
  if (row.telegramMessageId == null) return;
  // Deep-link the Open Task button to the Mini App routed at #/calendar
  // (the Mini App's hash router takes it from there — for now we land on
  // calendar; a future iteration can teach the router /task/<taskId>).
  const webAppUrl = new URL(env.WEBAPP_URL);
  webAppUrl.searchParams.set('tgWebAppStartParam', `task_${task.id}`);
  await tgCall('editMessageReplyMarkup', {
    chat_id: row.telegramChatId,
    message_id: row.telegramMessageId,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🗒 Открыть задачу', web_app: { url: webAppUrl.toString() } },
          { text: '🗑 Удалить фото', callback_data: `delphoto:${row.id}` },
        ],
      ],
    },
  });
}

export async function listPhotosForTask(taskId: string): Promise<TaskPhotoRow[]> {
  return db
    .select()
    .from(taskPhotos)
    .where(eq(taskPhotos.taskId, taskId))
    .orderBy(desc(taskPhotos.createdAt));
}

/**
 * All photos taken inside a family, optionally narrowed to one author.
 *
 * Used by the MemberProfile "Фото-отчёты" gallery. Joins through `tasks`
 * so we can family-scope without trusting the client's `userId` — even an
 * invalid one only returns rows where the photo's task is in this family.
 *
 * Returns newest-first; pagination is via `limit` + `beforeIso` cursor on
 * `createdAt` (simple keyset to avoid OFFSET cost on long histories).
 */
export async function listPhotosForFamily(input: {
  familyId: string;
  userId?: string;
  limit?: number;
  beforeIso?: string;
}): Promise<TaskPhotoRow[]> {
  const limit = Math.min(Math.max(input.limit ?? 60, 1), 200);
  const conds = [eq(tasks.familyId, input.familyId)];
  if (input.userId) conds.push(eq(taskPhotos.userId, input.userId));
  if (input.beforeIso) {
    conds.push(sql`${taskPhotos.createdAt} < ${new Date(input.beforeIso)}`);
  }
  const rows = await db
    .select({ photo: taskPhotos })
    .from(taskPhotos)
    .innerJoin(tasks, eq(taskPhotos.taskId, tasks.id))
    .where(and(...conds))
    .orderBy(desc(taskPhotos.createdAt))
    .limit(limit);
  return rows.map((r) => r.photo);
}

export async function listPhotosForOccurrence(occurrenceId: string): Promise<TaskPhotoRow[]> {
  return db
    .select()
    .from(taskPhotos)
    .where(eq(taskPhotos.occurrenceId, occurrenceId))
    .orderBy(desc(taskPhotos.createdAt));
}

export async function getPhotoById(photoId: string): Promise<TaskPhotoRow | null> {
  const row = await db.query.taskPhotos.findFirst({ where: eq(taskPhotos.id, photoId) });
  return row ?? null;
}

/**
 * Fetch a fresh Telegram CDN URL for the photo. The URL is short-lived
 * (≈ 1 hour per Telegram docs), so don't cache aggressively client-side.
 */
export async function getPhotoDownloadUrl(photo: TaskPhotoRow): Promise<string> {
  const result = await tgCall<GetFileResult>('getFile', { file_id: photo.telegramFileId });
  if (!result.file_path) {
    throw new PhotoServiceError('tg_getfile_failed', 'No file_path in getFile response');
  }
  return TG_FILE(result.file_path);
}

/**
 * Removes the photo row and best-effort deletes the bot's chat message.
 * Returns the row so callers can answer the bot callback nicely.
 */
export async function deletePhoto(photoId: string): Promise<TaskPhotoRow | null> {
  const photo = await getPhotoById(photoId);
  if (!photo) return null;

  // Delete the row first so the user sees it disappear in the Mini App even
  // if Telegram's deleteMessage is flaky / rate-limited.
  await db.delete(taskPhotos).where(eq(taskPhotos.id, photoId));

  if (photo.telegramMessageId != null) {
    // Best-effort cleanup of the bot's chat message. Telegram only allows
    // deleting bot messages within 48h, so older messages will get an
    // updated keyboard ("(удалено)") instead.
    try {
      await tgCall('deleteMessage', {
        chat_id: photo.telegramChatId,
        message_id: photo.telegramMessageId,
      });
    } catch (err) {
      logger.debug(
        { err, photoId },
        'deleteMessage failed — falling back to edit keyboard',
      );
      try {
        await tgCall('editMessageReplyMarkup', {
          chat_id: photo.telegramChatId,
          message_id: photo.telegramMessageId,
          reply_markup: { inline_keyboard: [] },
        });
        await tgCall('editMessageCaption', {
          chat_id: photo.telegramChatId,
          message_id: photo.telegramMessageId,
          caption: '🗑 Фото удалено',
        });
      } catch (err2) {
        logger.debug({ err: err2, photoId }, 'editMessage fallback also failed');
      }
    }
  }

  return photo;
}

/** Auth helper: does this user own the photo? */
export async function userOwnsPhoto(photoId: string, userId: string): Promise<boolean> {
  const row = await db.query.taskPhotos.findFirst({
    where: and(eq(taskPhotos.id, photoId), eq(taskPhotos.userId, userId)),
  });
  return !!row;
}

export function serializePhoto(row: TaskPhotoRow) {
  return {
    id: row.id,
    taskId: row.taskId,
    occurrenceId: row.occurrenceId,
    userId: row.userId,
    createdAt: row.createdAt.toISOString(),
  };
}

export { tasks }; // re-export for routes
