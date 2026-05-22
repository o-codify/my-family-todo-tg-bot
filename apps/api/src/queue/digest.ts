import { and, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { db } from '../db/client';
import {
  familyMembers,
  notificationsLog,
  taskOccurrences,
  tasks,
  users,
} from '../db/schema';
import { logger } from '../logger';
import { getNotificationsQueue } from './index';
import { localDate, localHHMM, isInQuietHours } from './quiet-hours';
import { sendBotMessage } from './tg-send';

/**
 * Build the digest job id from a user — used as the BullMQ "repeat key" so we
 * can replace it cleanly when the user's digestTime changes. BullMQ derives
 * its own opaque key from the repeat options, but the `jobId` is ours to
 * choose, and repeat-by-cron jobs with the same jobId are deduped.
 */
function repeatJobIdForUser(userId: string): string {
  return `digest:${userId}`;
}

/**
 * Build a cron string for the user's local digestTime in their timezone. The
 * BullMQ `repeat.tz` option does the heavy lifting — we just pass HH:MM.
 */
function cronForHHMM(hhmm: string): string {
  const [h, m] = hhmm.split(':').map((s) => String(Number(s)));
  return `${m} ${h} * * *`;
}

/**
 * Idempotent re-schedule for one user. Call this:
 *  - on first sign-in (initial schedule)
 *  - whenever the user's `notificationSettings.digestTime`, `digestEnabled`,
 *    or `timezone` changes
 *
 * The producer removes the old repeatable definition and (if enabled) adds
 * a fresh one. Safe to call on every settings PATCH — costs one Redis call
 * when nothing changed.
 */
export async function rescheduleDigestForUser(input: {
  userId: string;
  digestEnabled: boolean;
  digestTime: string;
  timezone: string;
}): Promise<void> {
  const queue = getNotificationsQueue();
  const repeatJobId = repeatJobIdForUser(input.userId);

  // Remove by id (no-op if not present). Cheaper than enumerating
  // `getJobSchedulers()` — we know our own id.
  await queue.removeJobScheduler(repeatJobId).catch(() => undefined);

  if (!input.digestEnabled) {
    logger.debug({ userId: input.userId }, 'digest disabled — not scheduling');
    return;
  }

  await queue.upsertJobScheduler(
    repeatJobId,
    {
      pattern: cronForHHMM(input.digestTime),
      tz: input.timezone,
    },
    {
      name: 'digest',
      data: { userId: input.userId, forDate: '' /* worker fills in */ } satisfies {
        userId: string;
        forDate: string;
      },
    },
  );
  logger.info(
    { userId: input.userId, digestTime: input.digestTime, tz: input.timezone },
    'digest job (re)scheduled',
  );
}

/**
 * Renders + sends one user's morning digest. Worker entry point.
 *
 * Idempotency: we insert into `notifications_log` with
 *   dedupe_key = `digest:<userId>:<localDate>`
 * before sending. If the insert fails on the unique index, we treat it as
 * "already sent today" and exit silently.
 *
 * Quiet hours: if the user's quiet window covers their digestTime, we skip.
 * That's intentional — digests fire at a user-chosen hour, so the user
 * controls overlap explicitly via their settings.
 */
export async function runDigest(input: { userId: string }): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, input.userId) });
  if (!user) {
    logger.warn({ userId: input.userId }, 'digest skipped: user not found');
    return;
  }

  const today = localDate(user.timezone);
  const dedupeKey = `digest:${user.id}:${today}`;

  // Quiet-hours guard. We allow the user to opt out per send; the dedupe
  // log still records the skipped attempt so re-tries don't fire it later.
  const settings = user.notificationSettings;
  const quiet = isInQuietHours({
    start: settings.quietHoursStart,
    end: settings.quietHoursEnd,
    nowLocal: localHHMM(user.timezone),
  });
  if (quiet) {
    logger.debug({ userId: user.id }, 'digest skipped: quiet hours');
    // Still mark as "handled" so we don't retry inside the window.
    await tryInsertLog(user.id, 'digest', dedupeKey);
    return;
  }

  // Insert the log row first — on unique-violation, bail out (already sent).
  const inserted = await tryInsertLog(user.id, 'digest', dedupeKey);
  if (!inserted) {
    logger.debug({ userId: user.id, dedupeKey }, 'digest already sent today');
    return;
  }

  // Find all of the user's pending occurrences for today (across all families).
  const todayStart = new Date(`${today}T00:00:00.000Z`);
  const todayEnd = new Date(`${today}T23:59:59.999Z`);
  const rows = await db
    .select({
      taskTitle: tasks.title,
      familyId: tasks.familyId,
      time: taskOccurrences.scheduledTime,
      points: tasks.points,
    })
    .from(taskOccurrences)
    .innerJoin(tasks, eq(taskOccurrences.taskId, tasks.id))
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
          // Date-less pending rows (floating tasks) are also "for today" in
          // the sense that they're outstanding work.
          and(
            isNull(taskOccurrences.scheduledDate),
            // available_at must be in the past (or absent) — i.e. not on cooldown.
            or(
              isNull(taskOccurrences.availableAt),
              lte(taskOccurrences.availableAt, todayEnd),
            ),
          ),
        ),
      ),
    );

  const isEn = user.locale === 'en';
  const greeting = isEn ? '☀️ Morning! Today on your list:' : '☀️ Доброе утро! На сегодня:';
  const empty = isEn ? '🎉 Nothing scheduled — enjoy.' : '🎉 На сегодня пусто — отдыхай.';

  if (rows.length === 0) {
    await sendBotMessage({ chatId: Number(user.telegramId), text: `${greeting}\n\n${empty}` });
    void todayStart; // intentionally unused but kept for symmetry
    return;
  }

  const lines = rows.map((r, i) => {
    const time = r.time ? ` · ${r.time.slice(0, 5)}` : '';
    const pts = r.points > 0 ? ` · +${r.points}` : '';
    return `${i + 1}. ${r.taskTitle}${time}${pts}`;
  });
  const body = `${greeting}\n${lines.join('\n')}`;
  await sendBotMessage({ chatId: Number(user.telegramId), text: body });
}

async function tryInsertLog(userId: string, kind: string, dedupeKey: string): Promise<boolean> {
  try {
    await db.insert(notificationsLog).values({ userId, kind, dedupeKey });
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return false;
    throw err;
  }
}
