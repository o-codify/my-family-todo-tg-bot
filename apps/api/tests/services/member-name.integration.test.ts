import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listFamilyMembers, setMemberName } from '../../src/services/families';
import { addMember, closeDb, makeFamily, makeUser, resetTables } from '../db-helpers';

describe('setMemberName (integration)', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('overrides the member name family-wide and exposes the raw override', async () => {
    const owner = await makeUser();
    const kid = await makeUser({ firstName: 'Telegram-Name', lastName: 'Surname' });
    const { family } = await makeFamily(owner);
    await addMember(family, kid, 'Child');

    const ok = await setMemberName({ familyId: family.id, userId: kid.id, displayName: '  Сын  ' });
    expect(ok).toBe(true);

    const members = await listFamilyMembers(family.id);
    const dto = members.find((m) => m.id === kid.id)!;
    expect(dto.firstName).toBe('Сын'); // trimmed override wins
    expect(dto.lastName).toBeNull(); // suppressed under an override
    expect(dto.displayName).toBe('Сын');
  });

  it('clears the override back to the Telegram name', async () => {
    const owner = await makeUser();
    const kid = await makeUser({ firstName: 'Real', lastName: 'Last' });
    const { family } = await makeFamily(owner);
    await addMember(family, kid, 'Child');

    await setMemberName({ familyId: family.id, userId: kid.id, displayName: 'Custom' });
    await setMemberName({ familyId: family.id, userId: kid.id, displayName: null });

    const dto = (await listFamilyMembers(family.id)).find((m) => m.id === kid.id)!;
    expect(dto.firstName).toBe('Real');
    expect(dto.lastName).toBe('Last');
    expect(dto.displayName).toBeNull();
  });

  it('treats an empty/whitespace name as a clear', async () => {
    const owner = await makeUser();
    const kid = await makeUser({ firstName: 'Real' });
    const { family } = await makeFamily(owner);
    await addMember(family, kid, 'Child');

    await setMemberName({ familyId: family.id, userId: kid.id, displayName: 'Custom' });
    await setMemberName({ familyId: family.id, userId: kid.id, displayName: '   ' });

    const dto = (await listFamilyMembers(family.id)).find((m) => m.id === kid.id)!;
    expect(dto.displayName).toBeNull();
    expect(dto.firstName).toBe('Real');
  });

  it('returns false for a non-member', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const { family } = await makeFamily(owner);

    const ok = await setMemberName({
      familyId: family.id,
      userId: stranger.id,
      displayName: 'Nope',
    });
    expect(ok).toBe(false);
  });
});
