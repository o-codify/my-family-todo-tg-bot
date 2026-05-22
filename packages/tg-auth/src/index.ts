import { parse, sign, validate } from '@telegram-apps/init-data-node';

export type TelegramInitDataUser = {
  id: number;
  isBot?: boolean;
  firstName: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
  isPremium?: boolean;
  photoUrl?: string;
  allowsWriteToPm?: boolean;
};

export type ParsedInitData = {
  user: TelegramInitDataUser;
  authDate: Date;
  hash: string;
  queryId?: string;
  startParam?: string;
  raw: string;
};

export class InitDataError extends Error {
  constructor(
    message: string,
    public readonly code: 'invalid' | 'expired' | 'no-user' | 'malformed',
  ) {
    super(message);
    this.name = 'InitDataError';
  }
}

// The library's TS types claim camelCase but at runtime parse() returns snake_case.
// We model what actually comes out at runtime here.
type RuntimeParsed = {
  auth_date: Date;
  hash: string;
  query_id?: string;
  start_param?: string;
  signature?: string;
  user?: {
    id: number | bigint;
    first_name: string;
    last_name?: string;
    username?: string;
    language_code?: string;
    is_premium?: boolean;
    is_bot?: boolean;
    photo_url?: string;
    allows_write_to_pm?: boolean;
  };
};

const DEFAULT_MAX_AGE_SECONDS = 60 * 60 * 24;

/**
 * Verifies a Telegram WebApp initData string against the bot token and parses it.
 * Throws InitDataError on any failure.
 */
export function verifyAndParseInitData(
  initData: string,
  botToken: string,
  options: { maxAgeSeconds?: number } = {},
): ParsedInitData {
  const maxAge = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;

  try {
    validate(initData, botToken, { expiresIn: maxAge });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/expired/i.test(message)) {
      throw new InitDataError(message, 'expired');
    }
    throw new InitDataError(message, 'invalid');
  }

  let parsed: RuntimeParsed;
  try {
    parsed = parse(initData) as unknown as RuntimeParsed;
  } catch (err) {
    throw new InitDataError(
      err instanceof Error ? err.message : 'Failed to parse initData',
      'malformed',
    );
  }

  const tgUser = parsed.user;
  if (!tgUser) {
    throw new InitDataError('initData missing user', 'no-user');
  }

  const user: TelegramInitDataUser = {
    id: Number(tgUser.id),
    isBot: tgUser.is_bot,
    firstName: tgUser.first_name,
    lastName: tgUser.last_name,
    username: tgUser.username,
    languageCode: tgUser.language_code,
    isPremium: tgUser.is_premium,
    photoUrl: tgUser.photo_url,
    allowsWriteToPm: tgUser.allows_write_to_pm,
  };

  return {
    user,
    authDate: parsed.auth_date,
    hash: parsed.hash,
    queryId: parsed.query_id,
    startParam: parsed.start_param,
    raw: initData,
  };
}

/**
 * Builds a valid signed initData string for tests using the same library
 * the production code validates against.
 */
export function signInitDataForTest(params: {
  user: TelegramInitDataUser;
  botToken: string;
  authDate?: Date;
  startParam?: string;
  queryId?: string;
}): string {
  const authDate = params.authDate ?? new Date();
  return sign(
    {
      user: {
        id: params.user.id,
        first_name: params.user.firstName,
        last_name: params.user.lastName,
        username: params.user.username,
        language_code: params.user.languageCode,
        is_premium: params.user.isPremium,
        photo_url: params.user.photoUrl,
        allows_write_to_pm: params.user.allowsWriteToPm,
      },
      ...(params.queryId ? { query_id: params.queryId } : {}),
      ...(params.startParam ? { start_param: params.startParam } : {}),
    },
    params.botToken,
    authDate,
  );
}
