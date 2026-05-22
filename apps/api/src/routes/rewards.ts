import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { tgAuth, type AuthVariables } from '../middleware/auth';
import { requireFamily, requirePermission, type FamilyVariables } from '../middleware/family';
import {
  archiveReward,
  createReward,
  getUserPoints,
  grantRedemption,
  listRedemptions,
  listRewards,
  redeemReward,
  rejectRedemption,
  serializeRedemption,
  serializeReward,
} from '../services/rewards';

const createRewardSchema = z.object({
  name: z.string().min(1).max(100),
  emoji: z.string().max(16).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  costPoints: z.number().int().positive().max(100_000),
});

export const rewardsRouter = new Hono<{ Variables: AuthVariables & FamilyVariables }>()
  .use('*', tgAuth)
  .use('*', requireFamily);

rewardsRouter.get('/', async (c) => {
  const familyId = c.get('familyId');
  const list = await listRewards(familyId);
  return c.json({ rewards: list.map(serializeReward) });
});

rewardsRouter.post(
  '/',
  requirePermission('reward.manage'),
  zValidator('json', createRewardSchema),
  async (c) => {
    const user = c.get('user');
    const familyId = c.get('familyId');
    const reward = await createReward({ familyId, createdBy: user.id, data: c.req.valid('json') });
    return c.json({ reward: serializeReward(reward) }, 201);
  },
);

rewardsRouter.delete('/:rewardId', requirePermission('reward.manage'), async (c) => {
  const familyId = c.get('familyId');
  const ok = await archiveReward({ rewardId: c.req.param('rewardId'), familyId });
  if (!ok) return c.json({ error: 'not_found' }, 404);
  return c.body(null, 204);
});

rewardsRouter.post('/:rewardId/redeem', requirePermission('reward.claim'), async (c) => {
  const user = c.get('user');
  const familyId = c.get('familyId');
  const result = await redeemReward({
    rewardId: c.req.param('rewardId'),
    familyId,
    userId: user.id,
  });
  if (result.kind === 'not_found') return c.json({ error: 'not_found' }, 404);
  if (result.kind === 'not_enough_points') {
    return c.json({ error: 'not_enough_points', needed: result.needed, balance: result.balance }, 400);
  }
  return c.json({ redemption: serializeRedemption(result.redemption) }, 201);
});

rewardsRouter.get('/redemptions', async (c) => {
  const familyId = c.get('familyId');
  const status = c.req.query('status') as 'pending' | 'granted' | 'rejected' | undefined;
  const user = c.req.query('userId') ?? undefined;
  const list = await listRedemptions({ familyId, userId: user, status });
  return c.json({ redemptions: list.map(serializeRedemption) });
});

rewardsRouter.post(
  '/redemptions/:redId/grant',
  requirePermission('reward.grant'),
  async (c) => {
    const user = c.get('user');
    const familyId = c.get('familyId');
    const ok = await grantRedemption({
      redemptionId: c.req.param('redId'),
      familyId,
      grantedBy: user.id,
    });
    if (!ok) return c.json({ error: 'not_found_or_not_pending' }, 404);
    return c.body(null, 204);
  },
);

rewardsRouter.post(
  '/redemptions/:redId/reject',
  requirePermission('reward.grant'),
  async (c) => {
    const familyId = c.get('familyId');
    const ok = await rejectRedemption({
      redemptionId: c.req.param('redId'),
      familyId,
    });
    if (!ok) return c.json({ error: 'not_found_or_not_pending' }, 404);
    return c.body(null, 204);
  },
);

rewardsRouter.get('/balance/me', async (c) => {
  const user = c.get('user');
  const familyId = c.get('familyId');
  const points = await getUserPoints({ familyId, userId: user.id });
  return c.json({ points });
});
