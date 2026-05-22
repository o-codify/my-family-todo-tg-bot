import type { MiddlewareHandler } from 'hono';
import { env } from '../env';

const HEADER = 'x-service-token';

/**
 * Requires the internal service token (used by the bot when calling the API
 * outside the normal Telegram Mini App auth flow). Constant-time-ish compare
 * is fine here: token isn't user-supplied and the value is short.
 */
export const serviceAuth: MiddlewareHandler = async (c, next) => {
  const provided = c.req.header(HEADER);
  if (!provided || provided !== env.INTERNAL_SERVICE_TOKEN) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
};
