import { sql as dsql } from 'drizzle-orm';
import { customAlphabet } from 'nanoid';
import { db, sql } from '../src/db/client';
import {
  families,
  familyMembers,
  roles,
  tasks,
  taskOccurrences,
  users,
  type FamilyRow,
  type RoleRow,
  type UserRow,
} from '../src/db/schema';
import { DEFAULT_ROLE_PERMISSIONS, SYSTEM_ROLES } from '@family-todo/shared';

const slug = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);

export async function makeUser(overrides: Partial<UserRow> = {}): Promise<UserRow> {
  const [row] = await db
    .insert(users)
    .values({
      telegramId: BigInt(Math.floor(Math.random() * 1e12)),
      firstName: `User-${slug()}`,
      color: '#4ECDC4',
      ...overrides,
    })
    .returning();
  return row!;
}

export async function makeFamily(owner: UserRow): Promise<{
  family: FamilyRow;
  rolesByName: Record<string, RoleRow>;
}> {
  return db.transaction(async (tx) => {
    const [family] = await tx
      .insert(families)
      .values({
        name: `Fam-${slug()}`,
        ownerId: owner.id,
        inviteCode: slug().toUpperCase().slice(0, 8),
      })
      .returning();

    const insertedRoles = await tx
      .insert(roles)
      .values(
        SYSTEM_ROLES.map((name) => ({
          familyId: family!.id,
          name: name[0]!.toUpperCase() + name.slice(1),
          isSystem: true,
          permissions: DEFAULT_ROLE_PERMISSIONS[name],
        })),
      )
      .returning();

    const rolesByName = Object.fromEntries(insertedRoles.map((r) => [r.name, r]));

    await tx.insert(familyMembers).values({
      familyId: family!.id,
      userId: owner.id,
      roleId: rolesByName.Owner!.id,
    });

    return { family: family!, rolesByName };
  });
}

export async function addMember(
  family: FamilyRow,
  user: UserRow,
  roleName: 'Owner' | 'Adult' | 'Child',
): Promise<void> {
  const role = await db.query.roles.findFirst({
    where: dsql`${roles.familyId} = ${family.id} AND ${roles.name} = ${roleName}`,
  });
  if (!role) throw new Error(`role ${roleName} missing for family ${family.id}`);
  await db.insert(familyMembers).values({
    familyId: family.id,
    userId: user.id,
    roleId: role.id,
  });
}

/**
 * Truncates app tables (preserving migrations). Call between integration tests.
 */
export async function resetTables(): Promise<void> {
  await db.execute(dsql`
    TRUNCATE TABLE
      ${taskOccurrences},
      ${tasks},
      ${familyMembers},
      ${roles},
      ${families},
      ${users}
    RESTART IDENTITY CASCADE
  `);
}

export async function closeDb(): Promise<void> {
  await sql.end();
}
