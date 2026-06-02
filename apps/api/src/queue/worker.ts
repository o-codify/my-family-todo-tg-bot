import { Worker, type Job } from 'bullmq';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../db/client';
import { tasks, users } from '../db/schema';
import { logger } from '../logger';
import { rescheduleDigestForUser, runDigest } from './digest';
import { runReminder } from './reminder';
import {
  runGoogleSyncForUser,
  runGoogleSyncTick,
  scheduleGoogleSyncTick,
} from './google-cron';
import { isGoogleOauthConfigured } from '../services/google-crypto';
import { ensureQueuedOccurrence } from '../services/queue-tasks';
import { syncOccurrencesForTask } from '../services/occurrences';
import { or } from 'drizzle-orm';
import { NOTIFICATIONS_QUEUE, getConnectionOptions } from './index';

let worker: Worker | null = null;

/**
 * Start the in-process notifications worker. We co-locate this with the API
 * for now — a separate `apps/worker` process would be cleaner at scale, but
 * is overkill while volumes are tiny. The worker dispatches by `job.name`.
 */
export function startNotificationsWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(
    NOTIFICATIONS_QUEUE,
    async (job: Job) => {
      switch (job.name) {
        case 'digest':
          await runDigest({ userId: (job.data as { userId: string }).userId });
          return;
        case 'reminder':
          await runReminder(
            job.data as {
              occurrenceId: string;
              userId: string;
              taskTitle: string;
              minutesBefore?: number;
              canClose?: boolean;
            },
          );
          return;
        case 'google-sync-tick':
          await runGoogleSyncTick();
          return;
        case 'google-sync-user':
          await runGoogleSyncForUser((job.data as { userId: string }).userId);
          return;
        default:
          logger.warn({ jobName: job.name }, 'Unknown notification job');
      }
    },
    {
      connection: getConnectionOptions(),
      concurrency: 4,
    },
  );

  worker.on('failed', (job, err) => {
    logger.warn(
      { jobId: job?.id, jobName: job?.name, err: err.message },
      'notification job failed',
    );
  });
  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id, jobName: job.name }, 'notification job completed');
  });
  return worker;
}

export async function stopNotificationsWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}

/**
 * Boot-time hydration: walk all users with `digestEnabled` and ensure each has
 * a repeatable job. Idempotent because `rescheduleDigestForUser` removes any
 * stale scheduler with the same id before adding the new one.
 *
 * Called once from index.ts at startup, after the worker is started, so the
 * cron triggers a fresh schedule even if Redis lost state (e.g. wiped volume).
 */
export async function hydrateDigestSchedulers(): Promise<void> {
  const rows = await db
    .select({
      id: users.id,
      telegramId: users.telegramId,
      timezone: users.timezone,
      notificationSettings: users.notificationSettings,
    })
    .from(users)
    .where(isNotNull(users.telegramId));

  let scheduled = 0;
  for (const u of rows) {
    const s = u.notificationSettings;
    if (!s.digestEnabled) continue;
    await rescheduleDigestForUser({
      userId: u.id,
      digestEnabled: true,
      digestTime: s.digestTime,
      timezone: u.timezone,
    });
    scheduled++;
  }
  logger.info({ scheduled, total: rows.length }, 'digest schedulers hydrated');
  void eq; // keep import in case future filters need it
}

/**
 * Boot-time: walk every active queued task and call ensureQueuedOccurrence.
 *
 * This is the self-heal for the assignee drift the user hit: an earlier
 * over-broad dedup migration (0023) could remove dateless pendings
 * regardless of task type, sometimes flipping the rotation pivot. The
 * fix lives at the data layer: ensureQueuedOccurrence is idempotent
 * AND re-runs pickNextAssignee (which uses completion counts +
 * away-mode) to land the current row on the correct user. Calling it
 * once per queue task at boot normalises everyone's state without any
 * destructive SQL.
 */
export async function hydrateQueueAssignees(): Promise<void> {
  const queueTasks = await db
    .select()
    .from(tasks)
    .where(
      and(eq(tasks.type, 'queued'), isNull(tasks.archivedAt)),
    );
  let fixed = 0;
  for (const t of queueTasks) {
    try {
      const result = await ensureQueuedOccurrence(t);
      if ('occurrenceId' in result) fixed++;
    } catch (err) {
      logger.warn({ err, taskId: t.id }, 'queue hydrate failed for task');
    }
  }
  logger.info(
    { fixed, total: queueTasks.length },
    'queue assignees hydrated',
  );
}

/**
 * Boot-time: ensure every active recurring + oneoff task has its
 * occurrence rows materialised through the full
 * `OCCURRENCE_WINDOW_DAYS` look-ahead. New tasks created via
 * `createTask` already do this at insert time, but tasks created
 * back when the window was 30 days only have a month of rows
 * materialised — so flipping the calendar grid to month +3 or +6
 * shows nothing for them. syncOccurrencesForTask is idempotent
 * (onConflictDoNothing on the (taskId, scheduledDate) unique
 * index), so re-running here just tops up the missing future rows.
 */
export async function hydrateOccurrenceWindow(): Promise<void> {
  const expandableTasks = await db
    .select()
    .from(tasks)
    .where(
      and(
        isNull(tasks.archivedAt),
        or(eq(tasks.type, 'recurring'), eq(tasks.type, 'oneoff')),
      ),
    );
  let added = 0;
  for (const t of expandableTasks) {
    try {
      added += await syncOccurrencesForTask(t);
    } catch (err) {
      logger.warn(
        { err, taskId: t.id },
        'occurrence-window hydrate failed for task',
      );
    }
  }
  logger.info(
    { added, total: expandableTasks.length },
    'occurrence window hydrated',
  );
}

/** Boot-time: install the Google Calendar sync cron when configured.
 *  Skipped silently when env vars are missing — operators can deploy
 *  without Google integration and turn it on later by setting the
 *  GOOGLE_OAUTH_* + GOOGLE_TOKEN_ENC_KEY vars + restarting. */
export async function hydrateGoogleSyncCron(): Promise<void> {
  if (!isGoogleOauthConfigured()) {
    logger.debug('google-sync: env vars missing — cron not installed');
    return;
  }
  await scheduleGoogleSyncTick();
}
