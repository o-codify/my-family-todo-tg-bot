import { env } from './env';

type ApiInviteResponse = {
  family: { id: string; name: string; avatarUrl: string | null; inviteCode: string };
};

export class BotApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'BotApiError';
  }
}

export async function lookupInviteCode(code: string): Promise<ApiInviteResponse['family'] | null> {
  const url = `${env.BOT_API_BASE_URL}/internal/v1/invites/${encodeURIComponent(code)}`;
  const res = await fetch(url, {
    headers: { 'x-service-token': env.INTERNAL_SERVICE_TOKEN },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new BotApiError(`API ${res.status} ${url}`, res.status);
  }
  const data = (await res.json()) as ApiInviteResponse;
  return data.family;
}

/**
 * Tell the API to delete a photo on behalf of a Telegram user. The API
 * verifies the photo belongs to that chat before deleting.
 * Returns `true` on success, `false` if not found / forbidden.
 */
export async function deletePhotoForChat(
  photoId: string,
  telegramId: string | number,
): Promise<boolean> {
  const url = `${env.BOT_API_BASE_URL}/internal/v1/photos/${encodeURIComponent(photoId)}/delete`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-service-token': env.INTERNAL_SERVICE_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ telegramId: String(telegramId) }),
  });
  if (res.status === 404 || res.status === 403) return false;
  if (!res.ok) {
    throw new BotApiError(`API ${res.status} ${url}`, res.status);
  }
  return true;
}

export type TodayItem = {
  title: string;
  familyName: string;
  time: string | null;
  points: number;
};

export type TodayResponse = {
  locale: string;
  date: string;
  tasks: TodayItem[];
};

/**
 * Fetch today's pending tasks for a Telegram user (across all families).
 * Returns null if the user has never opened the Mini App (no DB row yet).
 */
export async function fetchTodayForUser(telegramId: number): Promise<TodayResponse | null> {
  const url = `${env.BOT_API_BASE_URL}/internal/v1/today/${telegramId}`;
  const res = await fetch(url, {
    headers: { 'x-service-token': env.INTERNAL_SERVICE_TOKEN },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new BotApiError(`API ${res.status} ${url}`, res.status);
  }
  return (await res.json()) as TodayResponse;
}
