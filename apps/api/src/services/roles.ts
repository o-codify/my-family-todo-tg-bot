import { and, eq } from 'drizzle-orm';
import type { Permission } from '@family-todo/shared';
import { db } from '../db/client';
import { familyMembers, roles, type RoleRow } from '../db/schema';

export async function listRoles(familyId: string): Promise<RoleRow[]> {
  return db.select().from(roles).where(eq(roles.familyId, familyId));
}

export async function updateRolePermissions(input: {
  roleId: string;
  familyId: string;
  permissions: Permission[];
}): Promise<RoleRow | null> {
  const role = await db.query.roles.findFirst({
    where: and(eq(roles.id, input.roleId), eq(roles.familyId, input.familyId)),
  });
  if (!role) return null;
  // Owner role is immutable
  if (role.name.toLowerCase() === 'owner') return role;
  const [updated] = await db
    .update(roles)
    .set({ permissions: input.permissions })
    .where(eq(roles.id, input.roleId))
    .returning();
  return updated ?? null;
}

export async function setMemberRole(input: {
  familyId: string;
  userId: string;
  roleId: string;
}): Promise<{ ok: boolean; reason?: 'not_found' | 'owner_role_forbidden' }> {
  // Verify role belongs to this family
  const role = await db.query.roles.findFirst({
    where: and(eq(roles.id, input.roleId), eq(roles.familyId, input.familyId)),
  });
  if (!role) return { ok: false, reason: 'not_found' };
  // The Owner role is immutable AND non-assignable: handing it out via
  // role.assign would let any role.manage holder grant themselves owner
  // permissions. Ownership changes go through the dedicated transfer-owner
  // flow, not here.
  if (role.name.toLowerCase() === 'owner') {
    return { ok: false, reason: 'owner_role_forbidden' };
  }
  const result = await db
    .update(familyMembers)
    .set({ roleId: input.roleId })
    .where(
      and(
        eq(familyMembers.familyId, input.familyId),
        eq(familyMembers.userId, input.userId),
      ),
    )
    .returning({ userId: familyMembers.userId });
  return { ok: result.length > 0, reason: result.length > 0 ? undefined : 'not_found' };
}
