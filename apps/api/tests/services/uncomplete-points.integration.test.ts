/**
 * Regression for: "Отменил выполнение задач, за которые получил баллы,
 * а их обратно не сняло." uncompleteOccurrence used to flip the row
 * back to 'pending' and zero its `pointsAwarded` field, but never
 * touched the points_ledger entry — so the user's running balance
 * kept the points even after the task wasn't done anymore.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client';
import { pointsLedger, taskOccurrences } from '../../src/db/schema';
import {
  completeOccurrence,
  uncompleteOccurrence,
} from '../../src/services/occurrence-actions';
import { createTask, getTaskInFamily } from '../../src/services/tasks';
import { getUserPoints } from '../../src/services/rewards';
import { closeDb, makeFamily, makeUser, resetTables } from '../db-helpers';

function isoTomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe('uncomplete reverses points (integration)', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('uncomplete deletes the points_ledger row tagged with this occurrence', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Worth 5',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow() },
        assigneeId: owner.id,
        points: 5,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    const taskFull = (await getTaskInFamily(task.id, family.id))!;
    const [occ] = await db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, task.id));

    // Backfill the assignee on the occurrence (createTask doesn't
    // propagate it for non-queue paths) so completeOccurrence's
    // ownership/points logic has someone to attribute to.
    await db
      .update(taskOccurrences)
      .set({ assigneeId: owner.id })
      .where(eq(taskOccurrences.id, occ!.id));

    // Complete → balance jumps to 5.
    await completeOccurrence({
      occurrence: { ...occ!, assigneeId: owner.id, task: taskFull },
      userId: owner.id,
      data: {},
    });
    const afterComplete = await getUserPoints({
      familyId: family.id,
      userId: owner.id,
    });
    expect(afterComplete).toBe(5);

    // Uncomplete → balance must drop back to 0, ledger row gone.
    await uncompleteOccurrence(occ!.id);
    const afterUncomplete = await getUserPoints({
      familyId: family.id,
      userId: owner.id,
    });
    expect(afterUncomplete).toBe(0);

    const ledgerRows = await db
      .select()
      .from(pointsLedger)
      .where(
        and(
          eq(pointsLedger.reason, 'task_completed'),
          eq(pointsLedger.refId, occ!.id),
        ),
      );
    expect(ledgerRows).toHaveLength(0);
  });

  it('re-completing after uncomplete re-awards points exactly once', async () => {
    // Guards against the "DELETE ledger row" path accidentally
    // double-awarding on the next completion — verifies the cycle is
    // symmetric.
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Worth 3',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow() },
        assigneeId: owner.id,
        points: 3,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    const taskFull = (await getTaskInFamily(task.id, family.id))!;
    const [occ] = await db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, task.id));
    await db
      .update(taskOccurrences)
      .set({ assigneeId: owner.id })
      .where(eq(taskOccurrences.id, occ!.id));

    await completeOccurrence({
      occurrence: { ...occ!, assigneeId: owner.id, task: taskFull },
      userId: owner.id,
      data: {},
    });
    await uncompleteOccurrence(occ!.id);
    // Refetch the occurrence — uncomplete zeroed its status.
    const [pending] = await db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.id, occ!.id));
    await completeOccurrence({
      occurrence: { ...pending!, task: taskFull },
      userId: owner.id,
      data: {},
    });

    const balance = await getUserPoints({
      familyId: family.id,
      userId: owner.id,
    });
    expect(balance).toBe(3);
  });
});
