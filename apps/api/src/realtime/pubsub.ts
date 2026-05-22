import IORedis from 'ioredis';
import { env } from '../env';
import { logger } from '../logger';

/**
 * Lightweight per-family Redis pub/sub layer for SSE.
 *
 * Why pub/sub and not just an in-process EventEmitter? Even at one API
 * instance today, doing it via Redis lets us add more instances later
 * without rewriting the publish hooks. The subscribe side multiplexes a
 * single Redis SUBSCRIBE connection across all SSE clients in this process
 * (one channel per family).
 *
 * Events are JSON-encoded `RealtimeEvent` payloads. Keep them tiny — they
 * are an "invalidate hint", not full state. The client re-fetches.
 */

export type RealtimeEvent =
  | { kind: 'invalidate'; scope: 'occurrences' | 'tasks' | 'members' | 'families' | 'stats' }
  | { kind: 'invalidate-all' };

function channelFor(familyId: string): string {
  return `family:${familyId}:events`;
}

let pubClient: IORedis | null = null;
let subClient: IORedis | null = null;
type Listener = (ev: RealtimeEvent) => void;
const listeners = new Map<string, Set<Listener>>();

function getPub(): IORedis {
  if (pubClient) return pubClient;
  pubClient = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
  });
  pubClient.on('error', (err) => logger.warn({ err }, 'realtime pub: redis error'));
  return pubClient;
}

function getSub(): IORedis {
  if (subClient) return subClient;
  subClient = new IORedis(env.REDIS_URL, {
    // Subscriber connections must not retry blocking commands per ioredis
    // docs — same convention BullMQ uses.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  subClient.on('error', (err) => logger.warn({ err }, 'realtime sub: redis error'));
  subClient.on('message', (channel, message) => {
    const set = listeners.get(channel);
    if (!set) return;
    let parsed: RealtimeEvent;
    try {
      parsed = JSON.parse(message);
    } catch (err) {
      logger.warn({ err, channel, message }, 'realtime: bad payload');
      return;
    }
    for (const fn of set) {
      try {
        fn(parsed);
      } catch (err) {
        logger.warn({ err }, 'realtime: listener threw');
      }
    }
  });
  return subClient;
}

/**
 * Publish an event to all SSE listeners attached to `familyId`. Fire-and-
 * forget — callers must not await this on the hot path. The publish itself
 * is one Redis PUBLISH, but we still wrap with `.catch` so a Redis hiccup
 * never breaks a user-facing mutation.
 */
export async function publishFamilyEvent(
  familyId: string,
  event: RealtimeEvent,
): Promise<void> {
  try {
    await getPub().publish(channelFor(familyId), JSON.stringify(event));
  } catch (err) {
    logger.warn({ err, familyId, event }, 'realtime publish failed');
  }
}

/**
 * Subscribe to one family's events. Returns an unsubscribe function. The
 * underlying Redis SUBSCRIBE is reused across listeners — we only
 * `subscribe` the first time and `unsubscribe` when the last listener for
 * that channel drops.
 */
export async function subscribeFamily(
  familyId: string,
  fn: Listener,
): Promise<() => void> {
  const channel = channelFor(familyId);
  let set = listeners.get(channel);
  if (!set) {
    set = new Set();
    listeners.set(channel, set);
    await getSub().subscribe(channel);
  }
  set.add(fn);
  return () => {
    const s = listeners.get(channel);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) {
      listeners.delete(channel);
      void getSub().unsubscribe(channel).catch(() => undefined);
    }
  };
}

export async function closeRealtime(): Promise<void> {
  if (pubClient) {
    pubClient.disconnect();
    pubClient = null;
  }
  if (subClient) {
    subClient.disconnect();
    subClient = null;
  }
  listeners.clear();
}
