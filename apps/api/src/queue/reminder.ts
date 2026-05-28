import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import {
  notificationsLog,
  taskOccurrences,
  tasks,
  users,
  type TaskOccurrenceRow,
  type TaskRow,
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

/** Per-(occurrence, recipient, interval) BullMQ jobId. A shared task fans
 *  out one reminder per recipient (responsible + participants), so the id
 *  carries the user too — otherwise two recipients of the same occurrence +
 *  interval would collide on a single job. */
function jobIdForOccurrence(occurrenceId: string, userId: string, minutes: number): string {
  // BullMQ (>=5.x) rejects custom job ids containing ':' (it reserves the
  // colon as a Redis key separator), so we join with '_'. UUIDs contain
  // hyphens but never underscores, so the parts stay unambiguous.
  return `reminder_${occurrenceId}_${userId}_${minutes}`;
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

/** Recipients of an occurrence's reminder: the responsible assignee plus
 *  every participant of a shared task. Participants get the same reminder —
 *  they just can't close it (the action buttons are withheld). Deduped, in
 *  case the assignee also appears in participantIds. Exported for unit tests. */
export function reminderRecipientIds(
  occ: Pick<TaskOccurrenceRow, 'assigneeId'>,
  task: Pick<TaskRow, 'participantIds'>,
): string[] {
  const ids = [occ.assigneeId, ...(task.participantIds ?? [])].filter(
    (x): x is string => !!x,
  );
  return [...new Set(ids)];
}

async function scheduleReminderFromRow(occ: TaskOccurrenceRow): Promise<Date | null> {
  // Cancel any previous jobs for this occurrence — caller might be
  // rescheduling/reassigning. Safe no-op if absent.
  await cancelReminderForOccurrence(occ.id);

  if (occ.status !== 'pending') return null;
  if (!occ.scheduledDate || !occ.scheduledTime) return null;
  if (!occ.assigneeId) return null;

  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, occ.taskId) });
  if (!task || task.archivedAt) return null;

  const recipientIds = reminderRecipientIds(occ, task);
  if (recipientIds.length === 0) return null;
  const recipients = await db.select().from(users).where(inArray(users.id, recipientIds));

  const queue = getNotificationsQueue();
  // One job per (recipient, interval). Each recipient uses their OWN
  // timezone + reminder intervals. Only the responsible gets the action
  // buttons (canClose) — participants can see the task but not close it.
  let earliest: Date | null = null;
  for (const user of recipients) {
    const intervals = resolveIntervals(user.notificationSettings);
    if (intervals.length === 0) continue;

    let occursAt: Date;
    try {
      occursAt = zonedDateTimeToUtc(occ.scheduledDate, occ.scheduledTime, user.timezone);
    } catch (err) {
      logger.warn({ err, occurrenceId: occ.id, userId: user.id }, 'reminder schedule: bad date/time');
      continue;
    }

    const canClose = user.id === occ.assigneeId;
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
          canClose,
        },
        {
          delay,
          jobId: jobIdForOccurrence(occ.id, user.id, before),
        },
      );
      if (!earliest || fireAt < earliest) earliest = fireAt;
    }
  }
  if (!earliest) {
    logger.debug({ occurrenceId: occ.id }, 'reminder skipped: all fire times in the past');
    return null;
  }
  logger.debug({ occurrenceId: occ.id, earliest, recipients: recipientIds.length }, 'reminders scheduled');
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
  // Reminders fan out per recipient (responsible + participants), so we
  // resolve the current recipient set to know which per-user job ids to
  // probe. If the occurrence/task is already gone there's nothing to cancel.
  const occ = await db.query.taskOccurrences.findFirst({
    where: eq(taskOccurrences.id, occurrenceId),
  });
  const recipientIds = new Set<string>();
  if (occ?.assigneeId) recipientIds.add(occ.assigneeId);
  if (occ) {
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, occ.taskId) });
    for (const p of task?.participantIds ?? []) recipientIds.add(p);
  }
  for (const userId of recipientIds) {
    for (const minutes of COMMON_INTERVAL_MINUTES) {
      try {
        const job = await queue.getJob(jobIdForOccurrence(occurrenceId, userId, minutes));
        if (job) await job.remove();
      } catch (err) {
        logger.debug({ err, occurrenceId, userId, minutes }, 'cancel reminder: lookup/remove failed');
      }
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
  /** Whether this recipient may close the task. True for the responsible
   *  assignee, false for participants. Older jobs omit it → default true
   *  (they were always assignee-only). Controls the action buttons. */
  canClose?: boolean;
}): Promise<void> {
  // Per-(user, interval) dedupe — a shared task reminds multiple recipients
  // for the same occurrence+interval, and the notifications_log unique index
  // is on dedupeKey alone, so the recipient must be part of the key.
  const intervalKey = input.minutesBefore != null ? `:${input.minutesBefore}` : '';
  const dedupeKey = `reminder:${input.occurrenceId}:${input.userId}${intervalKey}`;

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
  // Action buttons (Done / Tomorrow) only go to the responsible — they're
  // the one who can close or reschedule. Participants get the same reminder
  // text but no buttons (the callbacks would 403 for them anyway).
  // callback_data limit is 64 bytes; `<action>:<uuid>` is 7 + 36 = 43.
  const canClose = input.canClose !== false;
  await sendBotMessage({
    chatId: Number(user.telegramId),
    text,
    ...(canClose
      ? {
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
        }
      : {}),
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
