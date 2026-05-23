import { logger } from '../logger';
import { getValidAccessToken } from './google-oauth';

/**
 * Thin Google Calendar v3 REST wrapper. We don't pull in `googleapis`
 * (the official SDK) — it carries 30+ MB of unused service code. A
 * focused fetch wrapper is much smaller and easier to audit.
 *
 * All calls are scoped by `accessToken` (obtained via the OAuth
 * service's getValidAccessToken). The wrapper auto-handles 401 by
 * requesting a fresh token once and retrying.
 */

const BASE = 'https://www.googleapis.com/calendar/v3';

type GoogleCalendarEventInput = {
  /** Required, ≤1024 chars. */
  summary: string;
  description?: string;
  /** "YYYY-MM-DD" for all-day, or ISO datetime. */
  start: { date?: string; dateTime?: string; timeZone?: string };
  end: { date?: string; dateTime?: string; timeZone?: string };
  /** Used to find our events on the next reconcile. */
  extendedProperties?: { private?: Record<string, string> };
};

export type GoogleCalendarEvent = GoogleCalendarEventInput & {
  id: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  updated?: string;
};

async function call<T>(input: {
  userId: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  query?: Record<string, string>;
  /** Internal: prevents infinite recursion on the 401 retry. */
  retry?: boolean;
}): Promise<T | null> {
  const token = await getValidAccessToken(input.userId);
  if (!token) return null;

  const url = new URL(`${BASE}${input.path}`);
  if (input.query) {
    for (const [k, v] of Object.entries(input.query)) {
      url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), {
    method: input.method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(input.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
  });

  // 401 → access token expired between getValidAccessToken's slack
  // window and the request landing. Drop our cached token and retry
  // once.
  if (res.status === 401 && !input.retry) {
    // getValidAccessToken handles the refresh; we just call again.
    return call<T>({ ...input, retry: true });
  }
  if (!res.ok) {
    const text = await res.text();
    logger.warn(
      { status: res.status, path: input.path, text },
      'google calendar api error',
    );
    return null;
  }
  // DELETE returns no body.
  if (res.status === 204 || input.method === 'DELETE') return null;
  return (await res.json()) as T;
}

/** Create a dedicated "Family Todo" calendar in the user's account.
 *  Called once on first connect; the id is stored on the token row. */
export async function createDedicatedCalendar(input: {
  userId: string;
  summary: string;
  timeZone?: string;
}): Promise<{ id: string } | null> {
  const res = await call<{ id: string }>({
    userId: input.userId,
    method: 'POST',
    path: '/calendars',
    body: {
      summary: input.summary,
      description: 'Auto-synced from Family Todo (Telegram Mini App)',
      timeZone: input.timeZone ?? 'UTC',
    },
  });
  return res;
}

/** Insert one event. Returns the created event (with id). */
export async function insertEvent(input: {
  userId: string;
  calendarId: string;
  event: GoogleCalendarEventInput;
}): Promise<GoogleCalendarEvent | null> {
  return call<GoogleCalendarEvent>({
    userId: input.userId,
    method: 'POST',
    path: `/calendars/${encodeURIComponent(input.calendarId)}/events`,
    body: input.event,
  });
}

/** Patch an existing event. Only changed fields need to be passed. */
export async function patchEvent(input: {
  userId: string;
  calendarId: string;
  eventId: string;
  event: Partial<GoogleCalendarEventInput>;
}): Promise<GoogleCalendarEvent | null> {
  return call<GoogleCalendarEvent>({
    userId: input.userId,
    method: 'PATCH',
    path: `/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}`,
    body: input.event,
  });
}

export async function deleteEvent(input: {
  userId: string;
  calendarId: string;
  eventId: string;
}): Promise<void> {
  await call<void>({
    userId: input.userId,
    method: 'DELETE',
    path: `/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}`,
  });
}

/** List events in the user's dedicated calendar within a date window.
 *  We page through `nextPageToken` until exhausted — 2500 max per page
 *  per the API. Returns only events we created (filtered by
 *  extendedProperties.private.familyTodo=1). */
export async function listOurEvents(input: {
  userId: string;
  calendarId: string;
  timeMin: string;
  timeMax: string;
}): Promise<GoogleCalendarEvent[]> {
  const all: GoogleCalendarEvent[] = [];
  let pageToken: string | undefined;
  do {
    const query: Record<string, string> = {
      timeMin: input.timeMin,
      timeMax: input.timeMax,
      maxResults: '250',
      // The `privateExtendedProperty` filter lets us scope the query
      // to events we own — no risk of touching events the user added
      // by hand inside the same calendar.
      privateExtendedProperty: 'familyTodo=1',
      showDeleted: 'false',
      singleEvents: 'true',
    };
    if (pageToken) query.pageToken = pageToken;
    const res = await call<{
      items: GoogleCalendarEvent[];
      nextPageToken?: string;
    }>({
      userId: input.userId,
      method: 'GET',
      path: `/calendars/${encodeURIComponent(input.calendarId)}/events`,
      query,
    });
    if (!res) break;
    all.push(...(res.items ?? []));
    pageToken = res.nextPageToken;
  } while (pageToken);
  return all;
}
