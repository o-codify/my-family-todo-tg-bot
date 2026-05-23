import { and, asc, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db/client';
import { families, familyMembers, taskOccurrences, tasks, users } from '../db/schema';
import { serviceAuth } from '../middleware/service';
import { deletePhoto, getPhotoById } from '../services/photos';
import { localDate } from '../queue/quiet-hours';
import {
  completeOccurrence,
  rescheduleOccurrence,
} from '../services/occurrence-actions';

export const internalRouter = new Hono().use('*', serviceAuth);

internalRouter.get('/invites/:code', async (c) => {
  const code = c.req.param('code').trim().toUpperCase();
  const family = await db.query.families.findFirst({
    where: eq(families.inviteCode, code),
  });
  if (!family) {
    return c.json({ error: 'not_found' }, 404);
  }
  return c.json({
    family: {
      id: family.id,
      name: family.name,
      avatarUrl: family.avatarUrl,
      inviteCode: family.inviteCode,
    },
  });
});

/**
 * Bot-callback endpoint: delete a photo from the user's chat. The bot
 * receives a `callback_query` with data `delphoto:<photoId>` and forwards
 * here with the requesting user's telegram_id so we can verify ownership.
 */
internalRouter.post('/photos/:photoId/delete', async (c) => {
  const photoId = c.req.param('photoId');
  const body = (await c.req.json().catch(() => ({}))) as { telegramId?: string };
  const tgId = body.telegramId;
  if (!tgId) return c.json({ error: 'missing_telegram_id' }, 400);

  const photo = await getPhotoById(photoId);
  if (!photo) return c.json({ error: 'not_found' }, 404);
  if (String(photo.telegramChatId) !== String(tgId)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  await deletePhoto(photoId);
  return c.json({ ok: true });
});

/**
 * Bot-callback endpoint: list today's pending tasks for a Telegram user.
 * Powers the `/today` bot command. Returns task titles + scheduled times
 * across *all* families the user is in; the bot renders the list back to
 * the user as a plain message.
 */
internalRouter.get('/today/:telegramId', async (c) => {
  const tgIdStr = c.req.param('telegramId');
  let tgId: bigint;
  try {
    tgId = BigInt(tgIdStr);
  } catch {
    return c.json({ error: 'invalid_telegram_id' }, 400);
  }

  const user = await db.query.users.findFirst({ where: eq(users.telegramId, tgId) });
  if (!user) return c.json({ error: 'user_not_found' }, 404);

  const today = localDate(user.timezone);
  const todayEnd = new Date(`${today}T23:59:59.999Z`);
  const rows = await db
    .select({
      title: tasks.title,
      familyName: families.name,
      time: taskOccurrences.scheduledTime,
      points: tasks.points,
    })
    .from(taskOccurrences)
    .innerJoin(tasks, eq(taskOccurrences.taskId, tasks.id))
    .innerJoin(families, eq(tasks.familyId, families.id))
    .innerJoin(familyMembers, eq(familyMembers.familyId, tasks.familyId))
    .where(
      and(
        eq(familyMembers.userId, user.id),
        isNull(tasks.archivedAt),
        eq(taskOccurrences.status, 'pending'),
        or(
          eq(taskOccurrences.assigneeId, user.id),
          isNull(taskOccurrences.assigneeId),
        ),
        or(
          and(
            gte(taskOccurrences.scheduledDate, today),
            lte(taskOccurrences.scheduledDate, today),
          ),
          and(
            isNull(taskOccurrences.scheduledDate),
            or(
              isNull(taskOccurrences.availableAt),
              lte(taskOccurrences.availableAt, todayEnd),
            ),
          ),
        ),
      ),
    )
    .orderBy(asc(taskOccurrences.scheduledTime));

  return c.json({
    locale: user.locale,
    date: today,
    tasks: rows.map((r) => ({
      title: r.title,
      familyName: r.familyName,
      time: r.time ?? null,
      points: r.points,
    })),
  });
});

/**
 * Bot-callback endpoints for the reminder inline keyboard. The bot
 * looks up the user by `telegramId`, finds the occurrence, then runs
 * the regular service path (so points / badges / queue spawn all
 * fire). Both endpoints return { ok, status } so the bot can render
 * a short toast / answerCallbackQuery.
 */
internalRouter.post('/occurrences/:occurrenceId/complete-by-tg', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { telegramId?: string };
  if (!body.telegramId) return c.json({ error: 'missing_telegram_id' }, 400);
  const user = await db.query.users.findFirst({
    where: eq(users.telegramId, BigInt(body.telegramId)),
  });
  if (!user) return c.json({ error: 'user_not_found' }, 404);

  // Resolve task + family via the occurrence row directly (no familyId
  // in the URL — the bot doesn't know which family the link was for).
  const occRow = await db.query.taskOccurrences.findFirst({
    where: eq(taskOccurrences.id, c.req.param('occurrenceId')),
  });
  if (!occRow) return c.json({ error: 'occurrence_not_found' }, 404);
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, occRow.taskId),
  });
  if (!task) return c.json({ error: 'occurrence_not_found' }, 404);

  // Verify the user is a member of the task's family.
  const member = await db.query.familyMembers.findFirst({
    where: and(
      eq(familyMembers.familyId, task.familyId),
      eq(familyMembers.userId, user.id),
    ),
  });
  if (!member) return c.json({ error: 'forbidden' }, 403);

  try {
    const updated = await completeOccurrence({
      occurrence: { ...occRow, task },
      userId: user.id,
      data: {},
    });
    return c.json({ ok: true, status: updated.status });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 409);
  }
});

/** Reschedule an occurrence to +1 day. Used by the "⏰ Tomorrow"
 *  button on reminder messages. */
internalRouter.post('/occurrences/:occurrenceId/snooze-by-tg', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { telegramId?: string };
  if (!body.telegramId) return c.json({ error: 'missing_telegram_id' }, 400);
  const user = await db.query.users.findFirst({
    where: eq(users.telegramId, BigInt(body.telegramId)),
  });
  if (!user) return c.json({ error: 'user_not_found' }, 404);

  const occRow = await db.query.taskOccurrences.findFirst({
    where: eq(taskOccurrences.id, c.req.param('occurrenceId')),
  });
  if (!occRow) return c.json({ error: 'occurrence_not_found' }, 404);
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, occRow.taskId),
  });
  if (!task) return c.json({ error: 'occurrence_not_found' }, 404);

  // Same membership check as complete.
  const member = await db.query.familyMembers.findFirst({
    where: and(
      eq(familyMembers.familyId, task.familyId),
      eq(familyMembers.userId, user.id),
    ),
  });
  if (!member) return c.json({ error: 'forbidden' }, 403);

  if (!occRow.scheduledDate) {
    return c.json({ ok: false, error: 'no_date_to_snooze' }, 409);
  }
  const next = new Date(`${occRow.scheduledDate}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const targetIso = next.toISOString().slice(0, 10);
  try {
    const updated = await rescheduleOccurrence({
      occurrence: { ...occRow, task },
      scheduledDate: targetIso,
    });
    return c.json({ ok: true, newDate: updated.scheduledDate });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 409);
  }
});
