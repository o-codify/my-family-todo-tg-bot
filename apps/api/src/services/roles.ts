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
}): Promise<boolean> {
  // Verify role belongs to this family
  const role = await db.query.roles.findFirst({
    where: and(eq(roles.id, input.roleId), eq(roles.familyId, input.familyId)),
  });
  if (!role) return false;
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
  return result.length > 0;
}
