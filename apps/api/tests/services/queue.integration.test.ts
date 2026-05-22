import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client';
import { taskOccurrences, users } from '../../src/db/schema';
import { completeOccurrence } from '../../src/services/occurrence-actions';
import { createTask, getTaskInFamily } from '../../src/services/tasks';
import { addMember, closeDb, makeFamily, makeUser, resetTables } from '../db-helpers';

describe('queued tasks (integration)', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('creates initial pending occurrence assigned to one member', async () => {
    const owner = await makeUser();
    const child = await makeUser();
    const { family } = await makeFamily(owner);
    await addMember(family, child, 'Child');

    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Take out trash',
        type: 'queued',
        schedule: { kind: 'queued' },
        queueUserIds: [owner.id, child.id],
        points: 5,
        photoRequired: false,
        singleShot: false,
      },
    });

    const occ = await db.select().from(taskOccurrences).where(eq(taskOccurrences.taskId, task.id));
    expect(occ).toHaveLength(1);
    expect(occ[0]?.status).toBe('pending');
    expect([owner.id, child.id]).toContain(occ[0]?.assigneeId);
  });

  it('rotates assignee on completion (round-robin)', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const { family } = await makeFamily(a);
    await addMember(family, b, 'Adult');

    const task = await createTask({
      familyId: family.id,
      createdBy: a.id,
      data: {
        title: 'Q',
        type: 'queued',
        schedule: { kind: 'queued' },
        queueUserIds: [a.id, b.id],
        points: 0,
        photoRequired: false,
        singleShot: false,
      },
    });

    const taskFull = (await getTaskInFamily(task.id, family.id))!;

    const firstOcc = (
      await db
        .select()
        .from(taskOccurrences)
        .where(and(eq(taskOccurrences.taskId, task.id), eq(taskOccurrences.status, 'pending')))
    )[0]!;
    const firstAssignee = firstOcc.assigneeId!;

    await completeOccurrence({
      occurrence: { ...firstOcc, task: taskFull },
      userId: firstAssignee,
      data: {},
    });

    const pendingNow = (
      await db
        .select()
        .from(taskOccurrences)
        .where(and(eq(taskOccurrences.taskId, task.id), eq(taskOccurrences.status, 'pending')))
    )[0]!;
    const secondAssignee = pendingNow.assigneeId!;

    expect(secondAssignee).not.toBe(firstAssignee);
    expect([a.id, b.id]).toContain(secondAssignee);
  });

  it('skips members in away-mode', async () => {
    const a = await makeUser({ awayUntil: new Date(Date.now() + 24 * 60 * 60 * 1000) });
    const b = await makeUser();
    const { family } = await makeFamily(a);
    await addMember(family, b, 'Adult');

    const task = await createTask({
      familyId: family.id,
      createdBy: a.id,
      data: {
        title: 'Skip away',
        type: 'queued',
        schedule: { kind: 'queued' },
        queueUserIds: [a.id, b.id],
        points: 0,
        photoRequired: false,
        singleShot: false,
      },
    });

    const occ = (await db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, task.id)))[0]!;
    // a is away, so b must be the assignee
    expect(occ.assigneeId).toBe(b.id);
  });

  it('catches up imbalanced queue', async () => {
    // Setup: a has done a queued task many times, b not at all.
    // Next assignment should go to b.
    const a = await makeUser();
    const b = await makeUser();
    const { family } = await makeFamily(a);
    await addMember(family, b, 'Adult');

    const task = await createTask({
      familyId: family.id,
      createdBy: a.id,
      data: {
        title: 'Imbalance',
        type: 'queued',
        schedule: { kind: 'queued' },
        queueUserIds: [a.id, b.id],
        points: 0,
        photoRequired: false,
        singleShot: false,
      },
    });

    const taskFull = (await getTaskInFamily(task.id, family.id))!;

    // Force-complete the current occurrence as "a" 3 times to skew the balance.
    for (let i = 0; i < 3; i++) {
      const occ = (
        await db
          .select()
          .from(taskOccurrences)
          .where(and(eq(taskOccurrences.taskId, task.id), eq(taskOccurrences.status, 'pending')))
      )[0]!;
      // Manually reassign to "a" so we can complete as "a"
      await db
        .update(taskOccurrences)
        .set({ assigneeId: a.id })
        .where(eq(taskOccurrences.id, occ.id));
      const reloaded = (
        await db.select().from(taskOccurrences).where(eq(taskOccurrences.id, occ.id))
      )[0]!;
      await completeOccurrence({
        occurrence: { ...reloaded, task: taskFull },
        userId: a.id,
        data: {},
      });
    }

    const pending = (
      await db
        .select()
        .from(taskOccurrences)
        .where(and(eq(taskOccurrences.taskId, task.id), eq(taskOccurrences.status, 'pending')))
    )[0]!;
    expect(pending.assigneeId).toBe(b.id);
  });
});
