import { and, asc, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db/client';
import { families, familyMembers, taskOccurrences, tasks, users } from '../db/schema';
import { serviceAuth } from '../middleware/service';
import { deletePhoto, getPhotoById } from '../services/photos';
import { localDate } from '../queue/quiet-hours';

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
