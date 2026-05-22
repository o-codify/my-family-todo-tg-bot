import IORedis from 'ioredis';
import { Queue, type ConnectionOptions } from 'bullmq';
import { env } from '../env';
import { logger } from '../logger';

/**
 * Single BullMQ queue for all user-facing notifications:
 *  - `digest`   — repeatable per-user job that fires at user.digestTime
 *  - `reminder` — one-shot per-occurrence job (delayed)
 *
 * We use a single queue with discriminated job names because the volume is
 * low and shared connection/observability is more useful than strict
 * separation. The worker fans out by `job.name`.
 *
 * Redis connection is shared across the queue + worker via a single ioredis
 * instance. Use `maxRetriesPerRequest: null` per BullMQ requirements
 * (otherwise blocking commands fail).
 */
export const NOTIFICATIONS_QUEUE = 'notifications';

export type DigestJob = {
  userId: string;
  /** YYYY-MM-DD in the user's timezone; provided by the producer to keep the
   *  dedupe key deterministic across worker retries. */
  forDate: string;
};

export type ReminderJob = {
  userId: string;
  occurrenceId: string;
  /** Pre-rendered to keep the worker hot path simple — the producer assembles
   *  the human-readable task title at enqueue time. */
  taskTitle: string;
};

let connection: IORedis | null = null;
let notificationsQueue: Queue | null = null;

export function getRedisConnection(): IORedis {
  if (connection) return connection;
  connection = new IORedis(env.REDIS_URL, {
    // BullMQ requires this — blocking commands (BRPOP) loop forever, and the
    // default 20-retry timeout makes the worker silently die after ~1min.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  connection.on('error', (err) => {
    logger.warn({ err }, 'Redis connection error');
  });
  return connection;
}

export function getConnectionOptions(): ConnectionOptions {
  return getRedisConnection();
}

export function getNotificationsQueue(): Queue {
  if (notificationsQueue) return notificationsQueue;
  notificationsQueue = new Queue(NOTIFICATIONS_QUEUE, {
    connection: getConnectionOptions(),
    defaultJobOptions: {
      // Keep completed jobs for an hour for debugging; failures longer so we
      // can introspect after the fact.
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86_400 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
    },
  });
  return notificationsQueue;
}

/**
 * Graceful shutdown — called from the SIGINT/SIGTERM handler in index.ts.
 * Closing the queue flushes any in-flight enqueues; closing the connection
 * tears down the ioredis client.
 */
export async function closeQueue(): Promise<void> {
  if (notificationsQueue) {
    await notificationsQueue.close();
    notificationsQueue = null;
  }
  if (connection) {
    connection.disconnect();
    connection = null;
  }
}
