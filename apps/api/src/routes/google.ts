import { Hono } from 'hono';
import { tgAuth, type AuthVariables } from '../middleware/auth';
import { createDedicatedCalendar } from '../services/google-calendar';
import { isGoogleOauthConfigured } from '../services/google-crypto';
import {
  buildAuthUrl,
  disconnect,
  exchangeCode,
  getTokenRow,
  saveTokens,
} from '../services/google-oauth';

/**
 * Google Calendar integration endpoints. Two surfaces:
 *
 *   Authed (tgAuth) — under /api/v1/me/google-calendar:
 *     GET    /                  current connection status
 *     POST   /connect           returns the Google consent URL the user
 *                               should visit (Telegram WebApp opens it
 *                               in the system browser via openLink)
 *     POST   /disconnect        revoke + drop tokens
 *
 *   Public (no tgAuth) — under /api/v1/google:
 *     GET    /oauth/callback    Google redirects here; we exchange the
 *                               code, create a dedicated calendar, and
 *                               render a tiny "вернитесь в Telegram"
 *                               page. The user re-enters the Mini App
 *                               which polls /me/google-calendar.
 */

export const googleAuthedRouter = new Hono<{ Variables: AuthVariables }>().use(
  '*',
  tgAuth,
);

googleAuthedRouter.get('/', async (c) => {
  if (!isGoogleOauthConfigured()) {
    return c.json({ configured: false, connected: false }, 200);
  }
  const user = c.get('user');
  const row = await getTokenRow(user.id);
  return c.json({
    configured: true,
    connected: row !== null,
    calendarId: row?.calendarId ?? null,
    connectedAt: row?.connectedAt.toISOString() ?? null,
  });
});

googleAuthedRouter.post('/connect', async (c) => {
  if (!isGoogleOauthConfigured()) {
    return c.json({ error: 'google_oauth_not_configured' }, 503);
  }
  const user = c.get('user');
  const url = buildAuthUrl({ userId: user.id });
  return c.json({ url });
});

googleAuthedRouter.post('/disconnect', async (c) => {
  const user = c.get('user');
  const ok = await disconnect(user.id);
  return c.json({ disconnected: ok });
});

// Public callback router — NO tgAuth.
export const googlePublicRouter = new Hono();

googlePublicRouter.get('/oauth/callback', async (c) => {
  if (!isGoogleOauthConfigured()) {
    return c.html(renderHtml('Google OAuth is not configured on this server.'));
  }
  const code = c.req.query('code');
  const state = c.req.query('state');
  const errParam = c.req.query('error');
  if (errParam) {
    return c.html(renderHtml(`Google вернул ошибку: ${errParam}. Закройте окно.`));
  }
  if (!code || !state) {
    return c.html(renderHtml('Не пришли code / state. Попробуйте снова.'));
  }
  const result = await exchangeCode({ code, state });
  if (!result) {
    return c.html(renderHtml('Не удалось обменять код. Попробуйте снова.'));
  }
  // Create the dedicated calendar (idempotent-ish — if it exists we'd
  // get a duplicate, but Google doesn't enforce unique summaries; a
  // second connect after disconnect will mint a new one and the old
  // one stays orphaned, which is fine).
  const cal = await createDedicatedCalendarHelper({
    userId: result.userId,
    accessToken: result.tokens.access_token,
  });
  if (!cal) {
    return c.html(
      renderHtml('Авторизация прошла, но не удалось создать календарь. Напишите в поддержку.'),
    );
  }
  await saveTokens({
    userId: result.userId,
    accessToken: result.tokens.access_token,
    refreshToken: result.tokens.refresh_token ?? '',
    expiresInSeconds: result.tokens.expires_in,
    scope: result.tokens.scope,
    calendarId: cal.id,
  });
  return c.html(
    renderHtml(
      '✓ Google Calendar подключён. Возвращайтесь в Telegram — задачи начнут синхронизироваться в течение 5 минут.',
    ),
  );
});

/**
 * One-shot helper that creates the dedicated calendar using a raw
 * access token (we don't have it stored yet — the row in
 * google_oauth_tokens is what holds the encrypted version, but we
 * need the calendar id BEFORE we can write that row).
 */
async function createDedicatedCalendarHelper(input: {
  userId: string;
  accessToken: string;
}): Promise<{ id: string } | null> {
  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      summary: 'Family Todo',
      description: 'Auto-synced from Family Todo (Telegram Mini App)',
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { id: string };
  return { id: json.id };
  // (unused import suppression — the API wrapper version is what the
  // sync engine uses; here we go direct to avoid the chicken-and-egg
  // of getValidAccessToken needing the row that doesn't exist yet.)
  void createDedicatedCalendar;
}

function renderHtml(message: string): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Family Todo · Google Calendar</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; padding: 24px; max-width: 480px; margin: 0 auto; line-height: 1.45; }
  .card { background: #f6f5ee; border: 1.5px solid #e1ddc9; border-radius: 12px; padding: 16px; }
</style>
</head>
<body>
  <div class="card">${escapeHtml(message)}</div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
