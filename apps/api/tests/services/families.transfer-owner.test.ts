import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../src/db/client';
import { families, familyMembers, roles } from '../../src/db/schema';
import { transferOwnership } from '../../src/services/families';
import { addMember, closeDb, makeFamily, makeUser, resetTables } from '../db-helpers';

describe('transferOwnership (integration)', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('happy path: ownerId flips, roles swap (target → Owner, caller → Adult)', async () => {
    const owner = await makeUser();
    const adult = await makeUser();
    const { family } = await makeFamily(owner);
    await addMember(family, adult, 'Adult');

    const result = await transferOwnership({
      familyId: family.id,
      fromUserId: owner.id,
      toUserId: adult.id,
    });
    expect(result).toBe('ok');

    const refreshed = await db.query.families.findFirst({
      where: eq(families.id, family.id),
    });
    expect(refreshed?.ownerId).toBe(adult.id);

    const ownerRole = await db.query.roles.findFirst({
      where: and(eq(roles.familyId, family.id), eq(roles.name, 'Owner')),
    });
    const adultRole = await db.query.roles.findFirst({
      where: and(eq(roles.familyId, family.id), eq(roles.name, 'Adult')),
    });
    const newOwnerMembership = await db.query.familyMembers.findFirst({
      where: and(
        eq(familyMembers.familyId, family.id),
        eq(familyMembers.userId, adult.id),
      ),
    });
    const formerOwnerMembership = await db.query.familyMembers.findFirst({
      where: and(
        eq(familyMembers.familyId, family.id),
        eq(familyMembers.userId, owner.id),
      ),
    });
    expect(newOwnerMembership?.roleId).toBe(ownerRole?.id);
    expect(formerOwnerMembership?.roleId).toBe(adultRole?.id);
  });

  it('refuses when caller is not the current owner', async () => {
    const owner = await makeUser();
    const adult = await makeUser();
    const sibling = await makeUser();
    const { family } = await makeFamily(owner);
    await addMember(family, adult, 'Adult');
    await addMember(family, sibling, 'Adult');

    const result = await transferOwnership({
      familyId: family.id,
      fromUserId: adult.id, // not the owner
      toUserId: sibling.id,
    });
    expect(result).toBe('not_owner');

    const refreshed = await db.query.families.findFirst({
      where: eq(families.id, family.id),
    });
    expect(refreshed?.ownerId).toBe(owner.id); // unchanged
  });

  it('refuses when target is not a member', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const { family } = await makeFamily(owner);

    const result = await transferOwnership({
      familyId: family.id,
      fromUserId: owner.id,
      toUserId: stranger.id,
    });
    expect(result).toBe('not_member');
  });

  it('refuses self-transfer with same_user', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);

    const result = await transferOwnership({
      familyId: family.id,
      fromUserId: owner.id,
      toUserId: owner.id,
    });
    expect(result).toBe('same_user');
  });
});
