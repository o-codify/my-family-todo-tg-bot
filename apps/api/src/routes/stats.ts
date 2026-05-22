import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { statsQuerySchema } from '@family-todo/shared';
import { tgAuth, type AuthVariables } from '../middleware/auth';
import { requireFamily, type FamilyVariables } from '../middleware/family';
import { computeFamilyStats } from '../services/stats';

/**
 * GET /api/v1/families/:familyId/stats?period=week|month|all
 *
 * Returns a pre-aggregated stats payload (byMember + topTasks + streaks +
 * unfairness). Moved server-side because the Mini App was pulling every
 * occurrence in the period to compute these on the client, which doesn't
 * scale past small families.
 */
export const statsRouter = new Hono<{ Variables: AuthVariables & FamilyVariables }>()
  .use('*', tgAuth)
  .use('*', requireFamily);

statsRouter.get('/', zValidator('query', statsQuerySchema), async (c) => {
  const familyId = c.get('familyId');
  const user = c.get('user');
  const { period } = c.req.valid('query');
  const stats = await computeFamilyStats({
    familyId,
    requestingUserId: user.id,
    period,
  });
  return c.json(stats);
});
