import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { tgAuth, type AuthVariables } from '../middleware/auth';
import { requireFamily, type FamilyVariables } from '../middleware/family';
import {
  acceptTransfer,
  cancelTransfer,
  createTransfer,
  listFeed,
  listMyIncomingTransfers,
  rejectTransfer,
  serializeTransfer,
} from '../services/transfers';

const transferRewardSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('money'), amount: z.number().positive().optional(), currency: z.string().max(8).optional(), note: z.string().max(200).optional() }),
  z.object({ kind: z.literal('treat'), note: z.string().max(200).optional() }),
  z.object({ kind: z.literal('screen_time'), minutes: z.number().int().positive().optional() }),
  z.object({ kind: z.literal('favor'), note: z.string().max(200).optional() }),
  z.object({ kind: z.literal('custom'), note: z.string().max(200).optional() }),
]);

const createTransferSchema = z.object({
  occurrenceId: z.string().uuid(),
  toUserId: z.string().uuid(),
  mode: z.enum(['plain', 'swap', 'reward']).default('plain'),
  message: z.string().max(500).nullable().optional(),
  swapOccurrenceIds: z.array(z.string().uuid()).max(10).optional(),
  rewards: z.array(transferRewardSchema).max(5).optional(),
});

export const transfersRouter = new Hono<{ Variables: AuthVariables & FamilyVariables }>()
  .use('*', tgAuth)
  .use('*', requireFamily);

transfersRouter.get('/incoming', async (c) => {
  const user = c.get('user');
  const familyId = c.get('familyId');
  const rows = await listMyIncomingTransfers({ familyId, userId: user.id });
  return c.json({ transfers: rows.map(serializeTransfer) });
});

transfersRouter.get('/feed', async (c) => {
  const familyId = c.get('familyId');
  const rows = await listFeed(familyId);
  return c.json({ transfers: rows.map(serializeTransfer) });
});

transfersRouter.post('/', zValidator('json', createTransferSchema), async (c) => {
  const user = c.get('user');
  const familyId = c.get('familyId');
  const body = c.req.valid('json');
  const result = await createTransfer({
    familyId,
    fromUserId: user.id,
    occurrenceId: body.occurrenceId,
    toUserId: body.toUserId,
    mode: body.mode,
    message: body.message ?? null,
    swapOccurrenceIds: body.swapOccurrenceIds,
    rewards: body.rewards,
  });
  if (result.kind === 'occurrence_not_found') return c.json({ error: 'occurrence_not_found' }, 404);
  if (result.kind === 'not_assignee') return c.json({ error: 'not_assignee' }, 403);
  if (result.kind === 'recipient_not_member') return c.json({ error: 'recipient_not_member' }, 400);
  if (result.kind === 'invalid_swap') return c.json({ error: 'invalid_swap' }, 400);
  if (result.kind === 'already_pending') return c.json({ error: 'already_pending' }, 409);
  return c.json({ transfer: serializeTransfer(result.row) }, 201);
});

transfersRouter.post('/:transferId/accept', async (c) => {
  const user = c.get('user');
  const familyId = c.get('familyId');
  const result = await acceptTransfer({
    transferId: c.req.param('transferId'),
    familyId,
    userId: user.id,
  });
  if (result.kind === 'not_found') return c.json({ error: 'not_found' }, 404);
  if (result.kind === 'not_recipient') return c.json({ error: 'not_recipient' }, 403);
  if (result.kind === 'expired') return c.json({ error: 'expired' }, 410);
  return c.body(null, 204);
});

transfersRouter.post('/:transferId/reject', async (c) => {
  const user = c.get('user');
  const familyId = c.get('familyId');
  const result = await rejectTransfer({
    transferId: c.req.param('transferId'),
    familyId,
    userId: user.id,
  });
  if (result.kind === 'not_found') return c.json({ error: 'not_found' }, 404);
  return c.body(null, 204);
});

transfersRouter.post('/:transferId/cancel', async (c) => {
  const user = c.get('user');
  const familyId = c.get('familyId');
  const result = await cancelTransfer({
    transferId: c.req.param('transferId'),
    familyId,
    userId: user.id,
  });
  if (result.kind === 'not_found') return c.json({ error: 'not_found' }, 404);
  return c.body(null, 204);
});
