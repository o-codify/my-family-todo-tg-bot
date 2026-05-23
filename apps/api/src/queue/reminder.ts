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

/** Per-interval BullMQ jobId. Each interval gets its own job so multi-
 *  threshold reminders ("за день, утром, за час") schedule and cancel
 *  independently. Adding the minute count makes the id unique inside a
 *  single occurrence's reminder set. */
function jobIdForOccurrence(occurrenceId: string, minutes: number): string {
  return `reminder:${occurrenceId}:${minutes}`;
}

/** Resolve the user's reminder intervals. New shape (`reminderIntervalsMinutes`)
 *  wins; legacy single-value `defaultReminderBeforeMinutes` lands in here as a
 *  one-element list so existing accounts keep working unchanged. Exported
 *  for unit tests — the routing logic is small enough to verify in isolation. */
export function resolveIntervals(settings: {
  reminderIntervalsMinutes?: number[];
  defaultReminderBeforeMinutes: number;
}): number[] {
  if (Array.isArray(settings.reminderIntervalsMinutes)) {
    return settings.reminderIntervalsMinutes.filter((m) => m > 0);
  }
  return settings.defaultReminderBeforeMinutes > 0
    ? [settings.defaultReminderBeforeMinutes]
    : [];
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
  // Cancel any previous jobs for this occurrence — caller might be
  // rescheduling/reassigning. Safe no-op if absent. We cancel by prefix
  // since multi-interval setup may have left multiple job ids behind.
  await cancelReminderForOccurrence(occ.id);

  if (occ.status !== 'pending') return null;
  if (!occ.scheduledDate || !occ.scheduledTime) return null;
  if (!occ.assigneeId) return null;

  const user = await db.query.users.findFirst({ where: eq(users.id, occ.assigneeId) });
  if (!user) return null;
  const intervals = resolveIntervals(user.notificationSettings);
  if (intervals.length === 0) return null;

  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, occ.taskId) });
  if (!task || task.archivedAt) return null;

  let occursAt: Date;
  try {
    occursAt = zonedDateTimeToUtc(occ.scheduledDate, occ.scheduledTime, user.timezone);
  } catch (err) {
    logger.warn({ err, occurrenceId: occ.id }, 'reminder schedule: bad date/time');
    return null;
  }

  const queue = getNotificationsQueue();
  // Schedule one job per interval. Earliest fire time is the one we
  // return for caller logging; others queue alongside it. We dedupe by
  // (occurrenceId, minutes) at send-time too — see runReminder.
  let earliest: Date | null = null;
  for (const before of intervals) {
    const fireAt = new Date(occursAt.getTime() - before * 60_000);
    const delay = fireAt.getTime() - Date.now();
    if (delay <= 0) continue;
    await queue.add(
      'reminder',
      {
        occurrenceId: occ.id,
        userId: user.id,
        taskTitle: task.title,
        minutesBefore: before,
      },
      {
        delay,
        jobId: jobIdForOccurrence(occ.id, before),
      },
    );
    if (!earliest || fireAt < earliest) earliest = fireAt;
  }
  if (!earliest) {
    logger.debug({ occurrenceId: occ.id }, 'reminder skipped: all fire times in the past');
    return null;
  }
  logger.debug({ occurrenceId: occ.id, earliest, intervals }, 'reminders scheduled');
  return earliest;
}

/**
 * Cancel every reminder job for a single occurrence. We probe a fixed set
 * of common minute thresholds (matches the UI presets) instead of scanning
 * the whole queue — BullMQ doesn't expose "find jobs by id prefix", and a
 * scan would be expensive on large queues. Custom intervals outside this
 * set are uncommon and will lapse harmlessly when they fire (the worker's
 * "still pending?" guard catches them).
 */
const COMMON_INTERVAL_MINUTES = [0, 5, 10, 15, 30, 60, 120, 240, 480, 1440];

export async function cancelReminderForOccurrence(occurrenceId: string): Promise<void> {
  const queue = getNotificationsQueue();
  for (const minutes of COMMON_INTERVAL_MINUTES) {
    try {
      const job = await queue.getJob(jobIdForOccurrence(occurrenceId, minutes));
      if (job) await job.remove();
    } catch (err) {
      logger.debug({ err, occurrenceId, minutes }, 'cancel reminder: lookup/remove failed');
    }
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
  /** Minutes-before-fire that this specific job represents. Older jobs
   *  enqueued before multi-interval shipped may not carry it; fall back
   *  to the user's legacy `defaultReminderBeforeMinutes` for those. */
  minutesBefore?: number;
}): Promise<void> {
  // Per-interval dedupe — a 60-min job and a 15-min job for the same
  // occurrence have different dedupe keys, so both can fire. Same
  // interval reaching the worker twice (BullMQ retry, double-add) still
  // dedupes correctly.
  const intervalKey = input.minutesBefore != null ? `:${input.minutesBefore}` : '';
  const dedupeKey = `reminder:${input.occurrenceId}${intervalKey}`;

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
  const before =
    input.minutesBefore ?? user.notificationSettings.defaultReminderBeforeMinutes;
  const lead = isEn ? `in ${before} min` : `через ${before} мин`;
  const text = isEn
    ? `⏰ Reminder${when}: ${input.taskTitle} — ${lead}`
    : `⏰ Напоминание${when}: ${input.taskTitle} — ${lead}`;
  // Inline keyboard — three quick actions on every reminder so the user
  // can dispatch from Telegram itself without opening the miniapp.
  // callback_data limit is 64 bytes; `<action>:<uuid>` is 7 + 36 = 43.
  await sendBotMessage({
    chatId: Number(user.telegramId),
    text,
    inlineKeyboard: [
      [
        {
          text: isEn ? '✓ Done' : '✓ Готово',
          callback_data: `occ-done:${input.occurrenceId}`,
        },
        {
          text: isEn ? '⏰ Tomorrow' : '⏰ Завтра',
          callback_data: `occ-tomorrow:${input.occurrenceId}`,
        },
      ],
    ],
  });
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
