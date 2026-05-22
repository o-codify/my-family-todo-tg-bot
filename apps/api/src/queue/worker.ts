import { Worker, type Job } from 'bullmq';
import { eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client';
import { users } from '../db/schema';
import { logger } from '../logger';
import { rescheduleDigestForUser, runDigest } from './digest';
import { runReminder } from './reminder';
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
            job.data as { occurrenceId: string; userId: string; taskTitle: string },
          );
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
