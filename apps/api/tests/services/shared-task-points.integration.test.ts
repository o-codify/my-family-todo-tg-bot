import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client';
import { pointsLedger, taskOccurrences } from '../../src/db/schema';
import {
  approveOccurrence,
  completeOccurrence,
  getOccurrenceInFamily,
  uncompleteOccurrence,
} from '../../src/services/occurrence-actions';
import { createTask } from '../../src/services/tasks';
import { addMember, closeDb, makeFamily, makeUser, resetTables } from '../db-helpers';

function isoTomorrow(offset = 1): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

async function balance(userId: string): Promise<number> {
  const rows = await db.select().from(pointsLedger).where(eq(pointsLedger.userId, userId));
  return rows.reduce((sum, r) => sum + r.delta, 0);
}

describe('shared-task points (integration)', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('credits full points to the responsible and every participant', async () => {
    const owner = await makeUser();
    const a = await makeUser({ firstName: 'A' });
    const b = await makeUser({ firstName: 'B' });
    const { family } = await makeFamily(owner);
    await addMember(family, a, 'Adult');
    await addMember(family, b, 'Child');

    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Shared chore',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow(1) },
        assigneeId: owner.id, // responsible
        participantIds: [a.id, b.id],
        points: 10,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    // The assignee must NOT be duplicated into participantIds.
    expect(task.participantIds).toEqual([a.id, b.id]);

    const occ = (
      await db.select().from(taskOccurrences).where(eq(taskOccurrences.taskId, task.id))
    )[0]!;
    await completeOccurrence({ occurrence: { ...occ, task }, userId: owner.id, data: {} });

    expect(await balance(owner.id)).toBe(10);
    expect(await balance(a.id)).toBe(10);
    expect(await balance(b.id)).toBe(10);

    // Uncomplete reverses every participant's award.
    await uncompleteOccurrence(occ.id);
    expect(await balance(owner.id)).toBe(0);
    expect(await balance(a.id)).toBe(0);
    expect(await balance(b.id)).toBe(0);
  });

  it('defers all participant points until approval when gated', async () => {
    const owner = await makeUser();
    const kid = await makeUser({ firstName: 'Kid' });
    const helper = await makeUser({ firstName: 'Helper' });
    const { family } = await makeFamily(owner);
    await addMember(family, kid, 'Child');
    await addMember(family, helper, 'Adult');

    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Gated shared',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow(1) },
        assigneeId: kid.id, // responsible is a child → completion is gated
        participantIds: [helper.id],
        points: 7,
        photoRequired: false,
        requiresApproval: true,
        singleShot: false,
      },
    });
    const occ = (
      await db.select().from(taskOccurrences).where(eq(taskOccurrences.taskId, task.id))
    )[0]!;

    const afterComplete = await completeOccurrence({
      occurrence: { ...occ, task },
      userId: kid.id,
      data: {},
    });
    expect(afterComplete.status).toBe('pending_approval');
    // No points yet — for anyone.
    expect(await balance(kid.id)).toBe(0);
    expect(await balance(helper.id)).toBe(0);

    await approveOccurrence({ occurrenceId: occ.id, approverId: owner.id });
    expect(await balance(kid.id)).toBe(7);
    expect(await balance(helper.id)).toBe(7);
  });

  it('still credits only the completer for a solo task', async () => {
    const owner = await makeUser();
    const other = await makeUser({ firstName: 'Other' });
    const { family } = await makeFamily(owner);
    await addMember(family, other, 'Adult');

    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Solo',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow(1) },
        assigneeId: owner.id,
        points: 5,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    expect(task.participantIds).toBeNull();

    const occ = (
      await db.select().from(taskOccurrences).where(eq(taskOccurrences.taskId, task.id))
    )[0]!;
    await completeOccurrence({ occurrence: { ...occ, task }, userId: owner.id, data: {} });

    expect(await balance(owner.id)).toBe(5);
    expect(await balance(other.id)).toBe(0);
  });
});
