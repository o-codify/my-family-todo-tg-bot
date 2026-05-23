import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import {
  createPermissionRequestInputSchema,
  decidePermissionRequestInputSchema,
  PERMISSION_REQUEST_STATUSES,
} from '@family-todo/shared';
import { tgAuth, type AuthVariables } from '../middleware/auth';
import { requireFamily, type FamilyVariables } from '../middleware/family';
import {
  cancelRequest,
  createRequest,
  decideRequest,
  listRequests,
  serializePermissionRequest,
} from '../services/permission-requests';

/**
 * Permission requests endpoints. Two flows:
 *  - Any member: create + cancel-own
 *  - Holders of `permission.decide` (Owner/Adult by default): approve/deny
 *
 * Listing: GET `?status=...&mine=1` — `mine` scopes to the caller's own
 * requests (used by the kid-view page so siblings' asks don't leak).
 */
export const permissionRequestsRouter = new Hono<{
  Variables: AuthVariables & FamilyVariables;
}>()
  .use('*', tgAuth)
  .use('*', requireFamily);

permissionRequestsRouter.get('/', async (c) => {
  const url = new URL(c.req.url);
  const statusParam = url.searchParams.get('status');
  const mine = url.searchParams.get('mine') === '1';
  const status =
    statusParam && (PERMISSION_REQUEST_STATUSES as readonly string[]).includes(statusParam)
      ? (statusParam as (typeof PERMISSION_REQUEST_STATUSES)[number])
      : undefined;
  const rows = await listRequests({
    familyId: c.get('familyId'),
    status,
    requesterUserId: mine ? c.get('user').id : undefined,
  });
  return c.json({ requests: rows.map(serializePermissionRequest) });
});

permissionRequestsRouter.post(
  '/',
  zValidator('json', createPermissionRequestInputSchema),
  async (c) => {
    const row = await createRequest({
      familyId: c.get('familyId'),
      userId: c.get('user').id,
      data: c.req.valid('json'),
    });
    return c.json({ request: serializePermissionRequest(row) }, 201);
  },
);

permissionRequestsRouter.post(
  '/:requestId/decide',
  zValidator('json', decidePermissionRequestInputSchema),
  async (c) => {
    if (!c.get('permissions').includes('permission.decide')) {
      return c.json({ error: 'forbidden', permission: 'permission.decide' }, 403);
    }
    const body = c.req.valid('json');
    const row = await decideRequest({
      familyId: c.get('familyId'),
      requestId: c.req.param('requestId'),
      deciderUserId: c.get('user').id,
      decision: body.decision,
      reason: body.reason ?? null,
    });
    if (!row) return c.json({ error: 'request_not_found' }, 404);
    return c.json({ request: serializePermissionRequest(row) });
  },
);

permissionRequestsRouter.post('/:requestId/cancel', async (c) => {
  const row = await cancelRequest({
    familyId: c.get('familyId'),
    requestId: c.req.param('requestId'),
    userId: c.get('user').id,
  });
  if (!row) return c.json({ error: 'request_not_found_or_not_yours' }, 404);
  return c.json({ request: serializePermissionRequest(row) });
});
