import { Hono } from 'hono';
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
    createdAt: row?.createdAt.toISOString() ?? null,
    lastUsedAt: row?.lastUsedAt?.toISOString() ?? null,
  });
});

icsManageRouter.post('/issue', async (c) => {
  const row = await issueToken({
    userId: c.get('user').id,
    familyId: c.get('familyId'),
  });
  return c.json({ token: row.token, createdAt: row.createdAt.toISOString() });
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

icsPublicRouter.get('/:token.ics', async (c) => {
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
