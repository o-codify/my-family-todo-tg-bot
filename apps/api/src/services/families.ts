import { customAlphabet } from 'nanoid';
import { and, eq } from 'drizzle-orm';
import {
  DEFAULT_ROLE_PERMISSIONS,
  SYSTEM_ROLES,
  type Permission,
  type SystemRoleName,
} from '@family-todo/shared';
import { db } from '../db/client';
import {
  families,
  familyMembers,
  roles,
  type FamilyRow,
  type RoleRow,
  type UserRow,
} from '../db/schema';

const inviteAlphabet = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 8);

export function generateInviteCode(): string {
  return inviteAlphabet();
}

const ROLE_DISPLAY: Record<SystemRoleName, string> = {
  owner: 'Owner',
  adult: 'Adult',
  child: 'Child',
};

export async function createFamilyWithOwner(input: {
  owner: UserRow;
  name: string;
  avatarUrl?: string | null;
}): Promise<{ family: FamilyRow; ownerRole: RoleRow }> {
  return db.transaction(async (tx) => {
    const [family] = await tx
      .insert(families)
      .values({
        name: input.name,
        avatarUrl: input.avatarUrl ?? null,
        ownerId: input.owner.id,
        inviteCode: generateInviteCode(),
      })
      .returning();

    const insertedRoles = await tx
      .insert(roles)
      .values(
        SYSTEM_ROLES.map((name) => ({
          familyId: family!.id,
          name: ROLE_DISPLAY[name],
          isSystem: true,
          permissions: DEFAULT_ROLE_PERMISSIONS[name] as Permission[],
        })),
      )
      .returning();

    const ownerRole = insertedRoles.find((r) => r.name === ROLE_DISPLAY.owner);
    if (!ownerRole) throw new Error('Owner role not created');

    await tx.insert(familyMembers).values({
      familyId: family!.id,
      userId: input.owner.id,
      roleId: ownerRole.id,
    });

    return { family: family!, ownerRole };
  });
}

export async function joinFamilyByCode(input: {
  user: UserRow;
  code: string;
}): Promise<{ family: FamilyRow; role: RoleRow } | { error: 'not_found' | 'already_member' }> {
  const family = await db.query.families.findFirst({
    where: eq(families.inviteCode, input.code),
  });
  if (!family) return { error: 'not_found' };

  const existing = await db.query.familyMembers.findFirst({
    where: and(eq(familyMembers.familyId, family.id), eq(familyMembers.userId, input.user.id)),
  });
  if (existing) return { error: 'already_member' };

  const childRole = await db.query.roles.findFirst({
    where: and(eq(roles.familyId, family.id), eq(roles.name, ROLE_DISPLAY.child)),
  });
  if (!childRole) throw new Error('Child role missing for family');

  await db.insert(familyMembers).values({
    familyId: family.id,
    userId: input.user.id,
    roleId: childRole.id,
  });

  return { family, role: childRole };
}

export function serializeFamily(row: FamilyRow) {
  return {
    id: row.id,
    name: row.name,
    avatarUrl: row.avatarUrl,
    ownerId: row.ownerId,
    inviteCode: row.inviteCode,
    inviteCodeExpiresAt: row.inviteCodeExpiresAt?.toISOString() ?? null,
    pinnedNote: row.pinnedNote,
    pinnedNoteUpdatedBy: row.pinnedNoteUpdatedBy,
    pinnedNoteUpdatedAt: row.pinnedNoteUpdatedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function serializeRole(row: RoleRow) {
  return {
    id: row.id,
    familyId: row.familyId,
    name: row.name,
    isSystem: row.isSystem,
    permissions: row.permissions,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Owner-only: kick another member from the family. Refuses to remove the
 * owner themselves (they must `leaveFamily` after transferring ownership,
 * or `deleteFamily` outright). Returns null on success, error code otherwise.
 */
export async function kickMember(input: {
  familyId: string;
  userId: string;
}): Promise<'ok' | 'cannot_kick_owner' | 'not_member' | 'family_not_found'> {
  const family = await db.query.families.findFirst({
    where: eq(families.id, input.familyId),
  });
  if (!family) return 'family_not_found';
  if (family.ownerId === input.userId) return 'cannot_kick_owner';
  const existing = await db.query.familyMembers.findFirst({
    where: and(
      eq(familyMembers.familyId, input.familyId),
      eq(familyMembers.userId, input.userId),
    ),
  });
  if (!existing) return 'not_member';
  await db
    .delete(familyMembers)
    .where(
      and(eq(familyMembers.familyId, input.familyId), eq(familyMembers.userId, input.userId)),
    );
  return 'ok';
}

/**
 * Generate a new invite code and rotate it on the family row. Returns the
 * updated family. Concurrent rotates collide on the unique index — we retry
 * a few times before bailing out.
 */
export async function rotateInviteCode(familyId: string): Promise<FamilyRow | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateInviteCode();
    try {
      const [updated] = await db
        .update(families)
        .set({ inviteCode: code })
        .where(eq(families.id, familyId))
        .returning();
      if (!updated) return null;
      return updated;
    } catch (err) {
      // 23505 = unique_violation. Try again with a new code.
      if ((err as { code?: string }).code !== '23505') throw err;
    }
  }
  throw new Error('Failed to rotate invite code after retries');
}

/**
 * Rename / re-avatar the family, or edit the pinned note. Owner-only for
 * name/avatar (caller enforces); any member can edit the pinned note —
 * the route handler distinguishes (only `pinnedNote` is in the patch →
 * skip owner check, otherwise enforce).
 *
 * Empty-string `pinnedNote` clears the note (treated as null). The user
 * id of the editor is recorded so the UI can show "Maria · 2h ago".
 */
export async function updateFamily(input: {
  familyId: string;
  userId?: string; // editor (required when pinnedNote is in the patch)
  patch: {
    name?: string;
    avatarUrl?: string | null;
    pinnedNote?: string | null;
  };
}): Promise<FamilyRow | null> {
  const next: Partial<typeof families.$inferInsert> = {};
  if (input.patch.name !== undefined) next.name = input.patch.name.trim();
  if (input.patch.avatarUrl !== undefined) next.avatarUrl = input.patch.avatarUrl;
  if (input.patch.pinnedNote !== undefined) {
    const trimmed = input.patch.pinnedNote?.trim() ?? null;
    next.pinnedNote = trimmed && trimmed.length > 0 ? trimmed : null;
    next.pinnedNoteUpdatedBy = input.userId ?? null;
    next.pinnedNoteUpdatedAt = new Date();
  }
  if (Object.keys(next).length === 0) {
    const row = await db.query.families.findFirst({ where: eq(families.id, input.familyId) });
    return row ?? null;
  }
  const [row] = await db
    .update(families)
    .set(next)
    .where(eq(families.id, input.familyId))
    .returning();
  return row ?? null;
}

/**
 * Hard-delete the family. Cascade through `families.id` FKs takes care of
 * members, roles, tasks, occurrences, catalog, templates, rewards, etc.
 * Owner-only — caller enforces.
 */
export async function deleteFamily(familyId: string): Promise<void> {
  await db.delete(families).where(eq(families.id, familyId));
}

/**
 * Owner-only: hand the family's ownership over to another existing
 * member. Atomic so the family is never without an owner:
 *   1. Move `families.ownerId` to the new user.
 *   2. Assign the new user the system "Owner" role (it always exists
 *      per family — created at family-create time).
 *   3. Demote the old owner to "Adult" so they keep useful permissions
 *      but lose owner-exclusive ones (e.g. transferring back).
 *
 * Errors:
 *   - `family_not_found` — bad familyId
 *   - `not_owner`        — caller isn't the current owner
 *   - `not_member`       — target user isn't in the family
 *   - `same_user`        — caller transferring to themselves
 *   - `missing_roles`    — defensive; the Owner/Adult system roles for
 *                          this family don't exist (shouldn't happen).
 */
export async function transferOwnership(input: {
  familyId: string;
  fromUserId: string;
  toUserId: string;
}): Promise<
  | 'ok'
  | 'family_not_found'
  | 'not_owner'
  | 'not_member'
  | 'same_user'
  | 'missing_roles'
> {
  if (input.fromUserId === input.toUserId) return 'same_user';

  return await db.transaction(async (tx) => {
    const family = await tx.query.families.findFirst({
      where: eq(families.id, input.familyId),
    });
    if (!family) return 'family_not_found' as const;
    if (family.ownerId !== input.fromUserId) return 'not_owner' as const;

    const targetMembership = await tx.query.familyMembers.findFirst({
      where: and(
        eq(familyMembers.familyId, input.familyId),
        eq(familyMembers.userId, input.toUserId),
      ),
    });
    if (!targetMembership) return 'not_member' as const;

    // System roles are seeded per-family at create time. They're
    // identified by `(familyId, name=…)` where the name is the
    // display string ("Owner" / "Adult" / "Child"). We look them
    // up rather than caching IDs because the user could have
    // renamed/duped them — but the display still maps deterministically.
    const ownerRole = await tx.query.roles.findFirst({
      where: and(
        eq(roles.familyId, input.familyId),
        eq(roles.name, ROLE_DISPLAY.owner),
      ),
    });
    const adultRole = await tx.query.roles.findFirst({
      where: and(
        eq(roles.familyId, input.familyId),
        eq(roles.name, ROLE_DISPLAY.adult),
      ),
    });
    if (!ownerRole || !adultRole) return 'missing_roles' as const;

    await tx
      .update(families)
      .set({ ownerId: input.toUserId })
      .where(eq(families.id, input.familyId));

    // Promote target to Owner role.
    await tx
      .update(familyMembers)
      .set({ roleId: ownerRole.id })
      .where(
        and(
          eq(familyMembers.familyId, input.familyId),
          eq(familyMembers.userId, input.toUserId),
        ),
      );

    // Demote previous owner to Adult — they keep most family-management
    // powers but lose owner-exclusive ones (transfer / delete family).
    await tx
      .update(familyMembers)
      .set({ roleId: adultRole.id })
      .where(
        and(
          eq(familyMembers.familyId, input.familyId),
          eq(familyMembers.userId, input.fromUserId),
        ),
      );

    return 'ok' as const;
  });
}

export async function leaveFamily(input: {
  familyId: string;
  userId: string;
}): Promise<{ kind: 'left' } | { kind: 'owner_must_transfer' } | { kind: 'not_member' }> {
  const family = await db.query.families.findFirst({
    where: eq(families.id, input.familyId),
  });
  if (!family) return { kind: 'not_member' };
  if (family.ownerId === input.userId) {
    return { kind: 'owner_must_transfer' };
  }
  const existing = await db.query.familyMembers.findFirst({
    where: and(eq(familyMembers.familyId, input.familyId), eq(familyMembers.userId, input.userId)),
  });
  if (!existing) return { kind: 'not_member' };
  await db
    .delete(familyMembers)
    .where(
      and(eq(familyMembers.familyId, input.familyId), eq(familyMembers.userId, input.userId)),
    );
  return { kind: 'left' };
}

export async function listFamilyMembers(familyId: string) {
  const { users } = await import('../db/schema');
  const rows = await db
    .select({
      userId: familyMembers.userId,
      displayName: familyMembers.displayName,
      joinedAt: familyMembers.joinedAt,
      role: roles,
      user: users,
    })
    .from(familyMembers)
    .innerJoin(roles, eq(familyMembers.roleId, roles.id))
    .innerJoin(users, eq(familyMembers.userId, users.id))
    .where(eq(familyMembers.familyId, familyId));

  return rows.map(({ user, role, joinedAt, displayName }) => ({
    id: user.id,
    // The owner-set name (when present) replaces the Telegram name family-wide.
    // `lastName` is suppressed under an override — the custom name is a single
    // free-form field, not a first/last pair.
    firstName: displayName ?? user.firstName,
    lastName: displayName ? null : user.lastName,
    // Raw override so the owner's edit UI can tell "custom" from "Telegram"
    // and prefill / clear accordingly.
    displayName: displayName ?? null,
    // Telegram handle — independent of the display-name override; the member
    // profile shows it under the name like the own-profile screen does.
    username: user.username,
    avatarUrl: user.avatarUrl,
    color: user.color,
    awayUntil: user.awayUntil?.toISOString() ?? null,
    awayReason: (user.awayReason as 'vacation' | 'sick' | null) ?? null,
    joinedAt: joinedAt.toISOString(),
    role: serializeRole(role),
  }));
}

/**
 * Owner-only (route enforces): set or clear a family-scoped display-name
 * override for a member. Pass a trimmed non-empty string to set, or null /
 * empty to clear (falls back to the Telegram name). The target must be a
 * member of the family. Returns false if they aren't.
 */
export async function setMemberName(input: {
  familyId: string;
  userId: string;
  displayName: string | null;
}): Promise<boolean> {
  const trimmed = input.displayName?.trim();
  const next = trimmed && trimmed.length > 0 ? trimmed : null;
  const result = await db
    .update(familyMembers)
    .set({ displayName: next })
    .where(
      and(
        eq(familyMembers.familyId, input.familyId),
        eq(familyMembers.userId, input.userId),
      ),
    )
    .returning({ userId: familyMembers.userId });
  return result.length > 0;
}

export async function listMyFamilies(userId: string) {
  const rows = await db
    .select({ family: families, role: roles })
    .from(familyMembers)
    .innerJoin(families, eq(familyMembers.familyId, families.id))
    .innerJoin(roles, eq(familyMembers.roleId, roles.id))
    .where(eq(familyMembers.userId, userId));

  return rows.map(({ family, role }) => ({
    ...serializeFamily(family),
    myRole: serializeRole(role),
  }));
}
