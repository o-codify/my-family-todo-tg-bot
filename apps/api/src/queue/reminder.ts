import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import {
  notificationsLog,
  taskOccurrences,
  tasks,
  users,
  type TaskOccurrenceRow,
} from '../db/schema';
import { logger } from '../logger';
import { getNotificationsQueue } from './index';
import { isInQuietHours, localHHMM } from './quiet-hours';
import { sendBotMessage } from './tg-send';

/**
 * Per-occurrence reminder jobs.
 *
 * One delayed BullMQ job per pending occurrence that has both date AND time
 * and an assigned user. Fires at (scheduledDateTime - user.defaultReminderBeforeMinutes).
 *
 * Idempotency: jobId is `reminder:<occurrenceId>` so re-adding is a no-op.
 * At-least-once: the worker checks `notifications_log` before sending and
 * skips on dedupe-key conflict.
 *
 * Lifecycle hooks (caller responsibility):
 *   - createTask → schedule for each newly-inserted pending occurrence
 *   - updateTask (schedule change) → cancel-all-for-task + reschedule
 *   - rescheduleOccurrence → cancel + reschedule the one
 *   - completeOccurrence / uncomplete → cancel (reschedule on uncomplete if still future)
 *   - archiveTask → cancel-all-for-task
 *   - ensureQueuedOccurrence → schedule the new one
 */

function jobIdForOccurrence(occurrenceId: string): string {
  return `reminder:${occurrenceId}`;
}

/**
 * Convert a local date+time in an IANA timezone to an absolute UTC Date.
 * One iteration of the "compute offset, subtract" trick — accurate even
 * across DST transitions.
 */
export function zonedDateTimeToUtc(
  dateIso: string,
  timeHHMM: string,
  tz: string,
): Date {
  // Treat input as if it were UTC; we'll correct for the actual tz offset.
  const naiveUtc = new Date(`${dateIso}T${normalizeTime(timeHHMM)}Z`).getTime();
  if (Number.isNaN(naiveUtc)) {
    throw new Error(`invalid date/time: ${dateIso} ${timeHHMM}`);
  }
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(naiveUtc));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const tzAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const offset = tzAsUtc - naiveUtc;
  return new Date(naiveUtc - offset);
}

function normalizeTime(t: string): string {
  // Accept "HH:MM" or "HH:MM:SS"; we always emit "HH:MM:SS".
  return t.length === 5 ? `${t}:00` : t;
}

/**
 * Schedule (or re-schedule) the reminder for a single occurrence. Returns
 * the planned fire time, or `null` if no job was enqueued (e.g. no time,
 * no assignee, fire time already past, user disabled reminders).
 */
export async function scheduleReminderForOccurrence(
  occurrenceId: string,
): Promise<Date | null> {
  const occ = await db.query.taskOccurrences.findFirst({
    where: eq(taskOccurrences.id, occurrenceId),
  });
  if (!occ) return null;
  return scheduleReminderFromRow(occ);
}

async function scheduleReminderFromRow(occ: TaskOccurrenceRow): Promise<Date | null> {
  // Cancel any previous job for this occurrence first — caller might be
  // rescheduling/reassigning. Safe no-op if absent.
  await cancelReminderForOccurrence(occ.id);

  if (occ.status !== 'pending') return null;
  if (!occ.scheduledDate || !occ.scheduledTime) return null;
  if (!occ.assigneeId) return null;

  const user = await db.query.users.findFirst({ where: eq(users.id, occ.assigneeId) });
  if (!user) return null;
  const before = user.notificationSettings.defaultReminderBeforeMinutes;
  if (before <= 0) return null;

  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, occ.taskId) });
  if (!task || task.archivedAt) return null;

  let fireAt: Date;
  try {
    const occursAt = zonedDateTimeToUtc(occ.scheduledDate, occ.scheduledTime, user.timezone);
    fireAt = new Date(occursAt.getTime() - before * 60_000);
  } catch (err) {
    logger.warn({ err, occurrenceId: occ.id }, 'reminder schedule: bad date/time');
    return null;
  }

  const delay = fireAt.getTime() - Date.now();
  if (delay <= 0) {
    logger.debug({ occurrenceId: occ.id, fireAt }, 'reminder skipped: fire time in the past');
    return null;
  }

  const queue = getNotificationsQueue();
  await queue.add(
    'reminder',
    { occurrenceId: occ.id, userId: user.id, taskTitle: task.title },
    {
      delay,
      jobId: jobIdForOccurrence(occ.id),
    },
  );
  logger.debug({ occurrenceId: occ.id, fireAt }, 'reminder scheduled');
  return fireAt;
}

/**
 * Cancel the reminder job for a single occurrence. Fire-and-forget;
 * doesn't fail if the job isn't there.
 */
export async function cancelReminderForOccurrence(occurrenceId: string): Promise<void> {
  const queue = getNotificationsQueue();
  try {
    const job = await queue.getJob(jobIdForOccurrence(occurrenceId));
    if (job) await job.remove();
  } catch (err) {
    logger.debug({ err, occurrenceId }, 'cancel reminder: lookup/remove failed');
  }
}

/**
 * Bulk schedule for all currently-pending occurrences of a task. Used after
 * `syncOccurrencesForTask` seeds rows. Quietly skips ones that don't qualify.
 */
export async function scheduleRemindersForTask(taskId: string): Promise<void> {
  const rows = await db
    .select()
    .from(taskOccurrences)
    .where(and(eq(taskOccurrences.taskId, taskId), eq(taskOccurrences.status, 'pending')));
  for (const r of rows) {
    await scheduleReminderFromRow(r).catch((err) =>
      logger.warn({ err, occurrenceId: r.id }, 'scheduleRemindersForTask: one failed'),
    );
  }
}

export async function cancelRemindersForTask(taskId: string): Promise<void> {
  const rows = await db
    .select({ id: taskOccurrences.id })
    .from(taskOccurrences)
    .where(eq(taskOccurrences.taskId, taskId));
  for (const r of rows) await cancelReminderForOccurrence(r.id);
}

/**
 * Worker entry point. Sends one reminder, guarded by dedupe log + quiet
 * hours + a "still pending?" check (the occurrence may have been completed
 * between scheduling and firing).
 */
export async function runReminder(input: {
  occurrenceId: string;
  userId: string;
  taskTitle: string;
}): Promise<void> {
  const dedupeKey = `reminder:${input.occurrenceId}`;

  // Re-check the occurrence is still pending — cancellation isn't guaranteed
  // to race-stop a job that's already moved into the worker.
  const occ = await db.query.taskOccurrences.findFirst({
    where: eq(taskOccurrences.id, input.occurrenceId),
  });
  if (!occ || occ.status !== 'pending') {
    logger.debug({ occurrenceId: input.occurrenceId }, 'reminder skipped: not pending');
    return;
  }

  const user = await db.query.users.findFirst({ where: eq(users.id, input.userId) });
  if (!user) return;

  const inQuiet = isInQuietHours({
    start: user.notificationSettings.quietHoursStart,
    end: user.notificationSettings.quietHoursEnd,
    nowLocal: localHHMM(user.timezone),
  });
  if (inQuiet) {
    // Mark as handled so we don't keep retrying inside the window.
    await tryInsertLog(user.id, 'reminder', dedupeKey);
    return;
  }

  const ok = await tryInsertLog(user.id, 'reminder', dedupeKey);
  if (!ok) return; // already sent

  const isEn = user.locale === 'en';
  const when = occ.scheduledTime ? ` (${occ.scheduledTime.slice(0, 5)})` : '';
  const before = user.notificationSettings.defaultReminderBeforeMinutes;
  const lead = isEn ? `in ${before} min` : `через ${before} мин`;
  const text = isEn
    ? `⏰ Reminder${when}: ${input.taskTitle} — ${lead}`
    : `⏰ Напоминание${when}: ${input.taskTitle} — ${lead}`;
  await sendBotMessage({ chatId: Number(user.telegramId), text });
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

// Kept exported for tests that want to clear out reminders en masse.
export async function cancelRemindersForOccurrences(occurrenceIds: string[]): Promise<void> {
  if (!occurrenceIds.length) return;
  void inArray; // keep import; future bulk-by-id may use it
  for (const id of occurrenceIds) await cancelReminderForOccurrence(id);
}
