import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client';
import { taskOccurrences } from '../../src/db/schema';
import { createTransfer } from '../../src/services/transfers';
import { createTask } from '../../src/services/tasks';
import { addMember, closeDb, makeFamily, makeUser, resetTables } from '../db-helpers';

function isoTomorrow(offset = 1): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

async function makeAssignedOccurrence(familyId: string, createdBy: string, assigneeId: string) {
  const task = await createTask({
    familyId,
    createdBy,
    data: {
      title: 'Chore',
      type: 'oneoff',
      schedule: { kind: 'oneoff', date: isoTomorrow(1) },
      assigneeId,
      points: 2,
      photoRequired: false,
      requiresApproval: false,
      singleShot: false,
    },
  });
  const occ = (
    await db.select().from(taskOccurrences).where(eq(taskOccurrences.taskId, task.id))
  )[0]!;
  return occ;
}

describe('createTransfer authorization (integration)', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('lets the assignee transfer to a fellow family member', async () => {
    const owner = await makeUser();
    const other = await makeUser({ firstName: 'Other' });
    const { family } = await makeFamily(owner);
    await addMember(family, other, 'Adult');
    const occ = await makeAssignedOccurrence(family.id, owner.id, owner.id);

    const result = await createTransfer({
      familyId: family.id,
      fromUserId: owner.id,
      occurrenceId: occ.id,
      toUserId: other.id,
    });
    expect(result.kind).toBe('created');
  });

  it('rejects transferring a task you are not assigned to', async () => {
    const owner = await makeUser();
    const other = await makeUser({ firstName: 'Other' });
    const { family } = await makeFamily(owner);
    await addMember(family, other, 'Adult');
    const occ = await makeAssignedOccurrence(family.id, owner.id, owner.id);

    const result = await createTransfer({
      familyId: family.id,
      fromUserId: other.id, // not the assignee
      occurrenceId: occ.id,
      toUserId: owner.id,
    });
    expect(result.kind).toBe('not_assignee');
  });

  it('rejects a recipient who is not a family member', async () => {
    const owner = await makeUser();
    const stranger = await makeUser({ firstName: 'Stranger' });
    const { family } = await makeFamily(owner);
    const occ = await makeAssignedOccurrence(family.id, owner.id, owner.id);

    const result = await createTransfer({
      familyId: family.id,
      fromUserId: owner.id,
      occurrenceId: occ.id,
      toUserId: stranger.id, // not in family
    });
    expect(result.kind).toBe('recipient_not_member');
  });

  it('cannot reach an occurrence in another family (IDOR)', async () => {
    const ownerA = await makeUser();
    const ownerB = await makeUser({ firstName: 'OwnerB' });
    const { family: familyA } = await makeFamily(ownerA);
    const { family: familyB } = await makeFamily(ownerB);
    const occB = await makeAssignedOccurrence(familyB.id, ownerB.id, ownerB.id);

    // Attacker in family A references family B's occurrence id.
    const result = await createTransfer({
      familyId: familyA.id,
      fromUserId: ownerA.id,
      occurrenceId: occB.id,
      toUserId: ownerA.id,
    });
    expect(result.kind).toBe('occurrence_not_found');
  });

  it('rejects swap occurrences from another family', async () => {
    const ownerA = await makeUser();
    const memberA = await makeUser({ firstName: 'MemberA' });
    const ownerB = await makeUser({ firstName: 'OwnerB' });
    const { family: familyA } = await makeFamily(ownerA);
    const { family: familyB } = await makeFamily(ownerB);
    await addMember(familyA, memberA, 'Adult');
    const occA = await makeAssignedOccurrence(familyA.id, ownerA.id, ownerA.id);
    const occB = await makeAssignedOccurrence(familyB.id, ownerB.id, ownerB.id);

    const result = await createTransfer({
      familyId: familyA.id,
      fromUserId: ownerA.id,
      occurrenceId: occA.id,
      toUserId: memberA.id,
      mode: 'swap',
      swapOccurrenceIds: [occB.id], // foreign occurrence
    });
    expect(result.kind).toBe('invalid_swap');
  });
});
