import type { MiddlewareHandler } from 'hono';
import { InitDataError, verifyAndParseInitData, type ParsedInitData } from '@family-todo/tg-auth';
import type { UserRow } from '../db/schema';
import { env } from '../env';
import { logger } from '../logger';
import { upsertTelegramUser } from '../services/users';

export type AuthVariables = {
  user: UserRow;
  initData: ParsedInitData;
};

const HEADER = 'authorization';
const SCHEME_PREFIX = 'tma ';

export const tgAuth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  const raw = c.req.header(HEADER);
  if (!raw) {
    return c.json({ error: 'missing_authorization' }, 401);
  }

  const initData = raw.startsWith(SCHEME_PREFIX) ? raw.slice(SCHEME_PREFIX.length) : raw;

  let parsed: ParsedInitData;
  try {
    parsed = verifyAndParseInitData(initData, env.TELEGRAM_BOT_TOKEN);
  } catch (err) {
    if (err instanceof InitDataError) {
      logger.debug({ code: err.code, msg: err.message }, 'initData verification failed');
      return c.json({ error: 'invalid_init_data', code: err.code }, 401);
    }
    throw err;
  }

  const user = await upsertTelegramUser(parsed.user);

  c.set('user', user);
  c.set('initData', parsed);

  await next();
};
