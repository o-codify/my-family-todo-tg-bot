import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client';
import { familyMembers } from '../../src/db/schema';
import { setMemberRole } from '../../src/services/roles';
import { addMember, closeDb, makeFamily, makeUser, resetTables } from '../db-helpers';

describe('setMemberRole authorization (integration)', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('refuses to assign the immutable Owner role (privilege escalation)', async () => {
    const owner = await makeUser();
    const member = await makeUser({ firstName: 'Member' });
    const { family, rolesByName } = await makeFamily(owner);
    await addMember(family, member, 'Adult');

    const result = await setMemberRole({
      familyId: family.id,
      userId: member.id,
      roleId: rolesByName.Owner!.id,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('owner_role_forbidden');

    // Membership unchanged — still the Adult role.
    const fm = await db.query.familyMembers.findFirst({
      where: eq(familyMembers.userId, member.id),
    });
    expect(fm?.roleId).toBe(rolesByName.Adult!.id);
  });

  it('assigns a normal role successfully', async () => {
    const owner = await makeUser();
    const member = await makeUser({ firstName: 'Member' });
    const { family, rolesByName } = await makeFamily(owner);
    await addMember(family, member, 'Child');

    const result = await setMemberRole({
      familyId: family.id,
      userId: member.id,
      roleId: rolesByName.Adult!.id,
    });
    expect(result.ok).toBe(true);

    const fm = await db.query.familyMembers.findFirst({
      where: eq(familyMembers.userId, member.id),
    });
    expect(fm?.roleId).toBe(rolesByName.Adult!.id);
  });
});
