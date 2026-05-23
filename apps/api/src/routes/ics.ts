import { Hono } from 'hono';
import { env } from '../env';
import { tgAuth, type AuthVariables } from '../middleware/auth';
import { requireFamily, type FamilyVariables } from '../middleware/family';
import {
  findActiveToken,
  generateFamilyIcs,
  issueToken,
  resolveToken,
  revokeActiveToken,
} from '../services/ics';

/**
 * Build the public feed URL from the server's own configured public URL
 * (env.API_PUBLIC_URL). Apple Calendar refuses to subscribe to HTTP
 * feeds — we MUST hand the user an HTTPS URL even in environments
 * where the miniapp itself is reached via http through a tunnel. The
 * client used to construct this URL from window.location.origin and
 * inherited the http scheme; building server-side avoids that. */
function buildFeedUrl(token: string): { url: string; webcal: string } {
  const base = env.API_PUBLIC_URL.replace(/\/+$/, '').replace(/\/api(\/v1)?$/, '');
  const url = `${base}/api/v1/ics/${token}.ics`;
  // webcal:// is the calendar-subscription protocol scheme Apple +
  // most other clients auto-recognise — tapping it on iOS opens the
  // Subscribe dialog directly. Strip the http(s):// from `url`.
  const webcal = `webcal://${url.replace(/^https?:\/\//, '')}`;
  return { url, webcal };
}

/**
 * Two surfaces:
 *  - Authenticated management under /api/v1/families/:familyId/ics —
 *    issue / revoke / inspect the caller's token.
 *  - Public feed under /api/v1/ics/:token.ics — auth is the token in
 *    the path; no tgAuth (calendar clients can't speak initData).
 */

export const icsManageRouter = new Hono<{
  Variables: AuthVariables & FamilyVariables;
}>()
  .use('*', tgAuth)
  .use('*', requireFamily);

icsManageRouter.get('/', async (c) => {
  const row = await findActiveToken({
    userId: c.get('user').id,
    familyId: c.get('familyId'),
  });
  return c.json({
    token: row?.token ?? null,
    url: row ? buildFeedUrl(row.token).url : null,
    webcal: row ? buildFeedUrl(row.token).webcal : null,
    createdAt: row?.createdAt.toISOString() ?? null,
    lastUsedAt: row?.lastUsedAt?.toISOString() ?? null,
  });
});

icsManageRouter.post('/issue', async (c) => {
  const row = await issueToken({
    userId: c.get('user').id,
    familyId: c.get('familyId'),
  });
  const { url, webcal } = buildFeedUrl(row.token);
  return c.json({
    token: row.token,
    url,
    webcal,
    createdAt: row.createdAt.toISOString(),
  });
});

icsManageRouter.post('/revoke', async (c) => {
  const ok = await revokeActiveToken({
    userId: c.get('user').id,
    familyId: c.get('familyId'),
  });
  return c.json({ revoked: ok });
});

/** Public feed router — no auth middleware. The token in the path is
 *  the credential. Returns 404 for unknown / revoked tokens. */
export const icsPublicRouter = new Hono();

// IMPORTANT: Hono's `:token` parameter matches greedily up to the next
// `/`, so the naive `/:token.ics` ended up parsing `.ics` as part of
// the param name (or capturing the entire segment including `.ics`),
// leaving `c.req.param('token')` empty. The explicit regex constraint
// bounds the param to base32-ish chars so the literal `.ics` suffix
// is left over to match outside the capture.
icsPublicRouter.get('/:token{[A-Za-z0-9]+}.ics', async (c) => {
  const token = c.req.param('token');
  if (!token) return c.json({ error: 'no_token' }, 400);
  const resolved = await resolveToken(token);
  if (!resolved) return c.json({ error: 'token_not_found_or_revoked' }, 404);
  const body = await generateFamilyIcs({ familyId: resolved.familyId });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      // Encourage Google/Apple to refetch frequently — once per hour
      // covers the "I just added a task" lag without thrashing.
      'Cache-Control': 'max-age=3600, public',
      'Content-Disposition': 'inline; filename="family.ics"',
    },
  });
});
