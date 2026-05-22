import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { InitDataError, verifyAndParseInitData } from '@family-todo/tg-auth';
import { db } from '../db/client';
import { familyMembers } from '../db/schema';
import { env } from '../env';
import { logger } from '../logger';
import { subscribeFamily } from '../realtime/pubsub';
import { upsertTelegramUser } from '../services/users';

/**
 * Server-sent events stream.
 *
 * EventSource (the browser API) can't set custom headers, so we accept the
 * Telegram `initData` blob via the `auth` query string. Same HMAC check as
 * `tgAuth` middleware — just inlined for the unique transport.
 *
 * Path: `GET /api/v1/families/:familyId/events?auth=<initData>`
 *
 * The stream emits one JSON message per event from the family's Redis
 * channel. Clients invalidate the matching TanStack Query keys on receipt.
 * A heartbeat fires every 25s so reverse proxies don't idle-close the
 * connection.
 */
export const eventsRouter = new Hono();

const HEARTBEAT_MS = 25_000;

eventsRouter.get('/:familyId/events', async (c) => {
  const familyId = c.req.param('familyId');
  const auth = c.req.query('auth');
  if (!auth) return c.json({ error: 'missing_auth' }, 401);

  let parsed;
  try {
    parsed = verifyAndParseInitData(auth, env.TELEGRAM_BOT_TOKEN);
  } catch (err) {
    if (err instanceof InitDataError) {
      return c.json({ error: 'invalid_init_data', code: err.code }, 401);
    }
    throw err;
  }

  const user = await upsertTelegramUser(parsed.user);

  // Verify the user is actually in this family before we wire them to its
  // channel — otherwise any signed-in user could eavesdrop on any family.
  const membership = await db
    .select({ userId: familyMembers.userId })
    .from(familyMembers)
    .where(and(eq(familyMembers.familyId, familyId), eq(familyMembers.userId, user.id)))
    .limit(1);
  if (membership.length === 0) {
    return c.json({ error: 'family_not_found' }, 404);
  }

  return streamSSE(c, async (stream) => {
    let alive = true;
    const queue: string[] = [];
    let resolveTick: (() => void) | null = null;

    const wake = () => {
      if (resolveTick) {
        const r = resolveTick;
        resolveTick = null;
        r();
      }
    };

    const unsubscribe = await subscribeFamily(familyId, (event) => {
      queue.push(JSON.stringify(event));
      wake();
    });

    // Heartbeat — a comment line that EventSource ignores, but it keeps
    // reverse proxies (nginx default idle 60s) from cutting the connection.
    const heartbeat = setInterval(() => {
      queue.push('__heartbeat__');
      wake();
    }, HEARTBEAT_MS);

    stream.onAbort(() => {
      alive = false;
      clearInterval(heartbeat);
      void unsubscribe();
      wake();
    });

    // Initial "hello" so the client knows the stream is live.
    await stream.writeSSE({ data: JSON.stringify({ kind: 'hello' }), event: 'open' });

    while (alive) {
      while (queue.length > 0) {
        const next = queue.shift()!;
        if (next === '__heartbeat__') {
          await stream.writeSSE({ event: 'heartbeat', data: '' });
        } else {
          await stream.writeSSE({ event: 'message', data: next });
        }
      }
      if (!alive) break;
      // Wait for the next wake — either an event published or an abort.
      await new Promise<void>((resolve) => {
        resolveTick = resolve;
      });
    }
    logger.debug({ familyId, userId: user.id }, 'SSE stream closed');
  });
});
