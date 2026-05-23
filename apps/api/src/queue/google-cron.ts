import { getNotificationsQueue } from './index';
import { logger } from '../logger';
import { listConnectedUserIds, reconcileUserCalendar } from '../services/google-sync';

/**
 * Google Calendar sync — runs every 5 minutes via a BullMQ repeatable
 * job. The tick fans out: list connected users, enqueue one reconcile
 * job per. Each user's reconcile is a sequence of Google API calls
 * gated by the user's access token.
 */

const TICK_JOB_ID = 'google-sync-tick';
const PER_USER_JOB_PREFIX = 'google-sync-user';

/** Schedule (or refresh) the every-5-min tick. Idempotent. */
export async function scheduleGoogleSyncTick(): Promise<void> {
  const queue = getNotificationsQueue();
  await queue.removeJobScheduler(TICK_JOB_ID).catch(() => undefined);
  await queue.upsertJobScheduler(
    TICK_JOB_ID,
    { pattern: '*/5 * * * *' }, // every 5 minutes
    { name: 'google-sync-tick', data: {} },
  );
  logger.info('google-sync tick scheduler installed (every 5 min)');
}

/** Worker entry: runs at each tick. Enqueues a per-user reconcile job
 *  for every connected user. Doing it via enqueueing (vs awaiting in
 *  the tick itself) lets BullMQ's concurrency take over and we don't
 *  block the worker thread on slow Google API responses. */
export async function runGoogleSyncTick(): Promise<void> {
  const queue = getNotificationsQueue();
  const ids = await listConnectedUserIds();
  for (const userId of ids) {
    await queue.add(
      'google-sync-user',
      { userId },
      {
        // Job id collapses duplicate enqueues within the same tick —
        // useful if the previous user-job is still queued.
        jobId: `${PER_USER_JOB_PREFIX}:${userId}`,
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
  }
  logger.debug({ count: ids.length }, 'google-sync tick fanned out');
}

/** Worker entry: runs the actual reconcile for one user. */
export async function runGoogleSyncForUser(userId: string): Promise<void> {
  try {
    await reconcileUserCalendar(userId);
  } catch (err) {
    logger.warn({ err, userId }, 'google-sync reconcile threw');
  }
}
