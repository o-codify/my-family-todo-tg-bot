import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { PERMISSIONS } from '@family-todo/shared';
import { serializeRole } from '../services/families';
import { tgAuth, type AuthVariables } from '../middleware/auth';
import { requireFamily, requirePermission, type FamilyVariables } from '../middleware/family';
import { listRoles, setMemberRole, updateRolePermissions } from '../services/roles';

const updatePermissionsSchema = z.object({
  permissions: z.array(z.enum(PERMISSIONS)),
});

const setMemberRoleSchema = z.object({
  userId: z.string().uuid(),
  roleId: z.string().uuid(),
});

export const rolesRouter = new Hono<{ Variables: AuthVariables & FamilyVariables }>()
  .use('*', tgAuth)
  .use('*', requireFamily);

rolesRouter.get('/', async (c) => {
  const familyId = c.get('familyId');
  const list = await listRoles(familyId);
  return c.json({ roles: list.map(serializeRole) });
});

rolesRouter.patch(
  '/:roleId',
  requirePermission('role.manage'),
  zValidator('json', updatePermissionsSchema),
  async (c) => {
    const familyId = c.get('familyId');
    const updated = await updateRolePermissions({
      roleId: c.req.param('roleId'),
      familyId,
      permissions: c.req.valid('json').permissions,
    });
    if (!updated) return c.json({ error: 'not_found' }, 404);
    return c.json({ role: serializeRole(updated) });
  },
);

rolesRouter.post(
  '/assign',
  requirePermission('role.manage'),
  zValidator('json', setMemberRoleSchema),
  async (c) => {
    const familyId = c.get('familyId');
    const body = c.req.valid('json');
    const result = await setMemberRole({ familyId, userId: body.userId, roleId: body.roleId });
    if (!result.ok) {
      if (result.reason === 'owner_role_forbidden') {
        return c.json({ error: 'owner_role_forbidden' }, 403);
      }
      return c.json({ error: 'not_found' }, 404);
    }
    return c.body(null, 204);
  },
);
