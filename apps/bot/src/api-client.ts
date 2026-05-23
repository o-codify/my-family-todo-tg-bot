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

/**
 * Normalize the configured API base — trim trailing slash and an optional
 * `/api` suffix. That way the operator can give us either form:
 *   - `http://family-todo-api:3000`             (internal docker network)
 *   - `https://my-family-todo.example.com`      (public host root)
 *   - `https://my-family-todo.example.com/api`  (same host as the miniapp,
 *                                                with `/api` already in the URL)
 * In every case we end up calling `<base>/api/internal/v1/...`.
 */
function normalizeBase(raw: string): string {
  return raw.trim().replace(/\/+$/, '').replace(/\/api$/, '');
}

const BASE = normalizeBase(env.BOT_API_BASE_URL);
const INTERNAL_PREFIX = `${BASE}/api/internal/v1`;

export async function lookupInviteCode(code: string): Promise<ApiInviteResponse['family'] | null> {
  const url = `${INTERNAL_PREFIX}/invites/${encodeURIComponent(code)}`;
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
  const url = `${INTERNAL_PREFIX}/photos/${encodeURIComponent(photoId)}/delete`;
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
/**
 * Bot-callback: complete an occurrence on behalf of a Telegram user.
 * Mirrors the regular /complete flow (points, badges, queue spawn).
 * Returns `null` when the call failed (404, 403, photo_required, etc.)
 * — the caller should answer the callback query with a friendly toast.
 */
export async function completeOccurrenceForChat(
  occurrenceId: string,
  telegramId: number,
): Promise<{ status: string } | null> {
  const url = `${INTERNAL_PREFIX}/occurrences/${encodeURIComponent(occurrenceId)}/complete-by-tg`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-service-token': env.INTERNAL_SERVICE_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ telegramId: String(telegramId) }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { ok: boolean; status?: string };
  return json.ok && json.status ? { status: json.status } : null;
}

/** Bot-callback: bump an occurrence's scheduled_date by 1 day. */
export async function snoozeOccurrenceForChat(
  occurrenceId: string,
  telegramId: number,
): Promise<{ newDate: string | null } | null> {
  const url = `${INTERNAL_PREFIX}/occurrences/${encodeURIComponent(occurrenceId)}/snooze-by-tg`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-service-token': env.INTERNAL_SERVICE_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ telegramId: String(telegramId) }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { ok: boolean; newDate?: string | null };
  return json.ok ? { newDate: json.newDate ?? null } : null;
}

export async function fetchTodayForUser(telegramId: number): Promise<TodayResponse | null> {
  const url = `${INTERNAL_PREFIX}/today/${telegramId}`;
  const res = await fetch(url, {
    headers: { 'x-service-token': env.INTERNAL_SERVICE_TOKEN },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new BotApiError(`API ${res.status} ${url}`, res.status);
  }
  return (await res.json()) as TodayResponse;
}
