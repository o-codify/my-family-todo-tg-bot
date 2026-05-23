import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pickAutoAssignee } from '../../src/services/auto-balance';
import { createTask } from '../../src/services/tasks';
import { addMember, closeDb, makeFamily, makeUser, resetTables } from '../db-helpers';

function isoTomorrow(offsetDays = 1): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

describe('auto-balance assignee (integration)', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('picks the only member when family has just an owner', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const pick = await pickAutoAssignee({ familyId: family.id });
    expect(pick).toBe(owner.id);
  });

  it('prefers the member with fewer pending occurrences', async () => {
    const owner = await makeUser();
    const kid = await makeUser({ firstName: 'Kid' });
    const { family } = await makeFamily(owner);
    await addMember(family, kid, 'Adult');

    // Give owner 2 pending tasks.
    await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Owner-1',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow(1) },
        assigneeId: owner.id,
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Owner-2',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow(2) },
        assigneeId: owner.id,
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    // Kid has 0.
    const pick = await pickAutoAssignee({ familyId: family.id });
    expect(pick).toBe(kid.id);
  });

  it('skips away members entirely', async () => {
    const owner = await makeUser({
      awayUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const kid = await makeUser({ firstName: 'Kid' });
    const { family } = await makeFamily(owner);
    await addMember(family, kid, 'Adult');

    const pick = await pickAutoAssignee({ familyId: family.id });
    expect(pick).toBe(kid.id); // owner is away → only kid eligible
  });

  it('returns null when every member is away', async () => {
    const owner = await makeUser({
      awayUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const { family } = await makeFamily(owner);
    const pick = await pickAutoAssignee({ familyId: family.id });
    expect(pick).toBeNull();
  });

  it('createTask with autoAssign uses the least-loaded user', async () => {
    const owner = await makeUser();
    const kid = await makeUser({ firstName: 'Kid' });
    const { family } = await makeFamily(owner);
    await addMember(family, kid, 'Adult');

    // Owner has 1 pending; kid has 0.
    await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Pin to owner',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow(1) },
        assigneeId: owner.id,
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Auto-pick',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow(3) },
        autoAssign: true,
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    expect(task.assigneeId).toBe(kid.id);
  });

  it('createTask: explicit assigneeId beats autoAssign', async () => {
    const owner = await makeUser();
    const kid = await makeUser({ firstName: 'Kid' });
    const { family } = await makeFamily(owner);
    await addMember(family, kid, 'Adult');

    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Both set',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow(1) },
        assigneeId: owner.id,
        autoAssign: true,
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    expect(task.assigneeId).toBe(owner.id);
  });
});
