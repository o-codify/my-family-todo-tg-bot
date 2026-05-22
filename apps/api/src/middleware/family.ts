import { and, eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Permission } from '@family-todo/shared';
import { db } from '../db/client';
import { familyMembers, roles, type RoleRow } from '../db/schema';
import type { AuthVariables } from './auth';

export type FamilyVariables = AuthVariables & {
  familyId: string;
  role: RoleRow;
  permissions: Permission[];
};

/**
 * Loads the family membership for the authenticated user.
 * Expects `:familyId` path param. 404 if not a member.
 */
export const requireFamily: MiddlewareHandler<{ Variables: FamilyVariables }> = async (c, next) => {
  const user = c.get('user');
  const familyId = c.req.param('familyId');
  if (!familyId) {
    throw new HTTPException(400, { message: 'familyId is required' });
  }

  const membership = await db
    .select({ role: roles })
    .from(familyMembers)
    .innerJoin(roles, eq(familyMembers.roleId, roles.id))
    .where(and(eq(familyMembers.familyId, familyId), eq(familyMembers.userId, user.id)))
    .limit(1);

  const row = membership[0];
  if (!row) {
    return c.json({ error: 'family_not_found' }, 404);
  }

  c.set('familyId', familyId);
  c.set('role', row.role);
  c.set('permissions', row.role.permissions);
  await next();
};

/**
 * Checks the loaded role contains `key`. Either pass a single key, or a function
 * to resolve the key dynamically (e.g. own vs any).
 */
export function requirePermission(
  key: Permission | ((c: { var: FamilyVariables }) => Permission | null),
): MiddlewareHandler<{ Variables: FamilyVariables }> {
  return async (c, next) => {
    const resolved =
      typeof key === 'function'
        ? key({
            var: {
              user: c.get('user'),
              initData: c.get('initData'),
              familyId: c.get('familyId'),
              role: c.get('role'),
              permissions: c.get('permissions'),
            },
          })
        : key;

    if (resolved === null) {
      await next();
      return;
    }

    if (!c.get('permissions').includes(resolved)) {
      return c.json({ error: 'forbidden', permission: resolved }, 403);
    }
    await next();
  };
}
