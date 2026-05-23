import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  createFamilySchema,
  joinFamilySchema,
  updateFamilySchema,
} from '@family-todo/shared';
import { db } from '../db/client';
import { families } from '../db/schema';
import { publishFamilyEvent } from '../realtime/pubsub';
import { tgAuth, type AuthVariables } from '../middleware/auth';
import { requireFamily, type FamilyVariables } from '../middleware/family';
import {
  createFamilyWithOwner,
  deleteFamily,
  joinFamilyByCode,
  kickMember,
  leaveFamily,
  listFamilyMembers,
  listMyFamilies,
  rotateInviteCode,
  serializeFamily,
  serializeRole,
  transferOwnership,
  updateFamily,
} from '../services/families';

export const familiesRouter = new Hono<{
  Variables: AuthVariables & Partial<FamilyVariables>;
}>().use('*', tgAuth);

familiesRouter.get('/', async (c) => {
  const user = c.get('user');
  const families = await listMyFamilies(user.id);
  return c.json({ families });
});

familiesRouter.post('/', zValidator('json', createFamilySchema), async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');

  const { family, ownerRole } = await createFamilyWithOwner({
    owner: user,
    name: body.name,
    avatarUrl: body.avatarUrl ?? null,
  });

  return c.json(
    {
      family: serializeFamily(family),
      myRole: serializeRole(ownerRole),
    },
    201,
  );
});

familiesRouter.get('/:familyId/members', requireFamily as never, async (c) => {
  const familyId = c.req.param('familyId');
  if (!familyId) return c.json({ error: 'family_id_required' }, 400);
  const members = await listFamilyMembers(familyId);
  return c.json({ members });
});

/**
 * PATCH /api/v1/families/:familyId — rename / change avatar (owner only),
 * or edit the pinned note (any member).
 *
 * Permission model: ownership in this app is hard-coded to `family.ownerId`
 * — even Owner-role members aren't the same as the *family owner*. We check
 * the owner-id directly here rather than relying on a permission key.
 *
 * The pinned note is the one exception: it's a shared scratchpad, so any
 * member can edit it. We branch on "patch contains ONLY pinnedNote" to
 * skip the owner check in that case.
 */
familiesRouter.patch(
  '/:familyId',
  requireFamily,
  zValidator('json', updateFamilySchema),
  async (c) => {
    const user = c.get('user');
    const familyId = c.req.param('familyId');
    const family = await db.query.families.findFirst({ where: eq(families.id, familyId) });
    if (!family) return c.json({ error: 'family_not_found' }, 404);
    const patch = c.req.valid('json');
    const keys = Object.keys(patch);
    const onlyPinnedNote = keys.length > 0 && keys.every((k) => k === 'pinnedNote');
    if (!onlyPinnedNote && family.ownerId !== user.id) {
      return c.json({ error: 'forbidden', reason: 'owner_only' }, 403);
    }
    const updated = await updateFamily({
      familyId,
      userId: user.id,
      patch,
    });
    if (!updated) return c.json({ error: 'family_not_found' }, 404);
    void publishFamilyEvent(familyId, { kind: 'invalidate', scope: 'families' });
    return c.json({ family: serializeFamily(updated) });
  },
);

/**
 * DELETE /api/v1/families/:familyId — owner only. Cascades through all FKs:
 * members, roles, tasks (→ occurrences, photos), catalog, templates, rewards.
 */
familiesRouter.delete('/:familyId', requireFamily, async (c) => {
  const user = c.get('user');
  const familyId = c.req.param('familyId');
  const family = await db.query.families.findFirst({ where: eq(families.id, familyId) });
  if (!family) return c.json({ error: 'family_not_found' }, 404);
  if (family.ownerId !== user.id) {
    return c.json({ error: 'forbidden', reason: 'owner_only' }, 403);
  }
  await deleteFamily(familyId);
  return c.body(null, 204);
});

/**
 * POST /api/v1/families/:familyId/invite/rotate — anyone with `member.invite`
 * can rotate the family invite code. Useful when a leaked code needs to be
 * replaced without unraveling the whole family.
 */
familiesRouter.post('/:familyId/invite/rotate', requireFamily, async (c) => {
  const familyId = c.req.param('familyId');
  if (!c.get('permissions').includes('member.invite')) {
    return c.json({ error: 'forbidden', permission: 'member.invite' }, 403);
  }
  const updated = await rotateInviteCode(familyId);
  if (!updated) return c.json({ error: 'family_not_found' }, 404);
  return c.json({ family: serializeFamily(updated) });
});

/**
 * DELETE /api/v1/families/:familyId/members/:userId — kick a member. Requires
 * `member.kick`. Can't kick the family owner (use delete-family or transfer).
 */
familiesRouter.delete('/:familyId/members/:userId', requireFamily, async (c) => {
  const familyId = c.req.param('familyId');
  const userId = c.req.param('userId');
  if (!c.get('permissions').includes('member.kick')) {
    return c.json({ error: 'forbidden', permission: 'member.kick' }, 403);
  }
  const result = await kickMember({ familyId, userId });
  if (result === 'family_not_found') return c.json({ error: 'family_not_found' }, 404);
  if (result === 'cannot_kick_owner') return c.json({ error: 'cannot_kick_owner' }, 409);
  if (result === 'not_member') return c.json({ error: 'not_member' }, 404);
  return c.body(null, 204);
});

/**
 * POST /api/v1/families/:familyId/transfer-owner — hand ownership to
 * another member. Owner-only (we check via families.ownerId, not the
 * permission system — ownership is intrinsic, not delegable). Body:
 * { toUserId: uuid }. On success the caller is demoted to Adult.
 */
familiesRouter.post('/:familyId/transfer-owner', async (c) => {
  const user = c.get('user');
  const familyId = c.req.param('familyId');
  if (!familyId) return c.json({ error: 'family_id_required' }, 400);
  const body = (await c.req.json().catch(() => null)) as { toUserId?: unknown } | null;
  const toUserId = typeof body?.toUserId === 'string' ? body.toUserId : null;
  if (!toUserId) return c.json({ error: 'to_user_id_required' }, 400);

  const result = await transferOwnership({
    familyId,
    fromUserId: user.id,
    toUserId,
  });
  if (result === 'family_not_found') return c.json({ error: 'family_not_found' }, 404);
  if (result === 'not_owner') return c.json({ error: 'not_owner' }, 403);
  if (result === 'not_member') return c.json({ error: 'not_member' }, 404);
  if (result === 'same_user') return c.json({ error: 'same_user' }, 400);
  if (result === 'missing_roles') return c.json({ error: 'missing_roles' }, 500);

  // Pub-sub so both the old and new owner's clients refresh role state.
  // 'families' invalidates the listMyFamilies query (which carries each
  // user's role per family), 'members' refreshes the per-family member
  // list so the new owner badge updates instantly.
  void publishFamilyEvent(familyId, { kind: 'invalidate', scope: 'families' });
  void publishFamilyEvent(familyId, { kind: 'invalidate', scope: 'members' });
  return c.json({ ok: true });
});

familiesRouter.post('/:familyId/leave', async (c) => {
  const user = c.get('user');
  const familyId = c.req.param('familyId');
  if (!familyId) return c.json({ error: 'family_id_required' }, 400);
  const result = await leaveFamily({ familyId, userId: user.id });
  if (result.kind === 'owner_must_transfer') {
    return c.json({ error: 'owner_must_transfer' }, 409);
  }
  if (result.kind === 'not_member') {
    return c.json({ error: 'not_member' }, 404);
  }
  return c.body(null, 204);
});

familiesRouter.get('/peek/:code', async (c) => {
  const code = c.req.param('code').trim().toUpperCase();
  if (!code) return c.json({ error: 'code_required' }, 400);

  const family = await db.query.families.findFirst({
    where: eq(families.inviteCode, code),
  });
  if (!family) return c.json({ error: 'not_found' }, 404);

  const members = await listFamilyMembers(family.id);
  const owner = members.find((m) => m.id === family.ownerId) ?? members[0];
  return c.json({
    family: {
      id: family.id,
      name: family.name,
      avatarUrl: family.avatarUrl,
      createdAt: family.createdAt.toISOString(),
      memberCount: members.length,
    },
    owner: owner
      ? {
          id: owner.id,
          firstName: owner.firstName,
          color: owner.color,
        }
      : null,
    members: members.map((m) => ({
      id: m.id,
      firstName: m.firstName,
      color: m.color,
    })),
  });
});

familiesRouter.post('/join', zValidator('json', joinFamilySchema), async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');

  const result = await joinFamilyByCode({ user, code: body.code.trim().toUpperCase() });

  if ('error' in result) {
    const status = result.error === 'not_found' ? 404 : 409;
    return c.json({ error: result.error }, status);
  }

  return c.json({
    family: serializeFamily(result.family),
    myRole: serializeRole(result.role),
  });
});
