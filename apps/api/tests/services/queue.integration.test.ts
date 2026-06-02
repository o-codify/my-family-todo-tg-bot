import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client';
import { taskOccurrences } from '../../src/db/schema';
import {
  completeOccurrence,
  uncompleteOccurrence,
} from '../../src/services/occurrence-actions';
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

  it('spawned next pending honours cooldownDays via availableAt', async () => {
    // Regression: completing a queue task with cooldownDays=6 used to
    // leave the next pending with availableAt=null, which made it
    // anchor to today on the calendar grid right after the user
    // finished the task. Now ensureQueuedOccurrence stamps
    // `availableAt = now + cooldownDays * 86_400_000`.
    const a = await makeUser();
    const b = await makeUser();
    const { family } = await makeFamily(a);
    await addMember(family, b, 'Adult');
    const task = await createTask({
      familyId: family.id,
      createdBy: a.id,
      data: {
        title: 'Cooldown trash',
        type: 'queued',
        schedule: { kind: 'queued' },
        queueUserIds: [a.id, b.id],
        cooldownDays: 6,
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
    const completeStart = Date.now();
    await completeOccurrence({
      occurrence: { ...firstOcc, task: taskFull },
      userId: firstOcc.assigneeId!,
      data: {},
    });
    const completeEnd = Date.now();

    const next = (
      await db
        .select()
        .from(taskOccurrences)
        .where(and(eq(taskOccurrences.taskId, task.id), eq(taskOccurrences.status, 'pending')))
    )[0]!;
    expect(next.availableAt).not.toBeNull();
    const availableAtMs = next.availableAt!.getTime();
    // Must land ~6 days from now. Allow generous window for test wall-clock drift.
    const expectMin = completeStart + 6 * 86_400_000 - 1000;
    const expectMax = completeEnd + 6 * 86_400_000 + 1000;
    expect(availableAtMs).toBeGreaterThanOrEqual(expectMin);
    expect(availableAtMs).toBeLessThanOrEqual(expectMax);
  });

  it('complete → uncomplete leaves exactly one pending (no duplicates)', async () => {
    // Regression test for "click checkbox → uncomplete → multiple pending
    // Мусор rows pile up" report. completeOccurrence spawns the next
    // round's pending via ensureQueuedOccurrence; uncompleteOccurrence
    // used to just flip the done row back to pending without cleaning up
    // the spawned successor, so each round added one duplicate.
    const a = await makeUser();
    const b = await makeUser();
    const { family } = await makeFamily(a);
    await addMember(family, b, 'Adult');

    const task = await createTask({
      familyId: family.id,
      createdBy: a.id,
      data: {
        title: 'No dupes',
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

    // Three complete → uncomplete cycles. Pre-fix this would leave 4
    // pending rows; we want exactly 1 at every cycle's end.
    for (let i = 0; i < 3; i++) {
      const current = (
        await db
          .select()
          .from(taskOccurrences)
          .where(and(eq(taskOccurrences.taskId, task.id), eq(taskOccurrences.status, 'pending')))
      )[0]!;
      await completeOccurrence({
        occurrence: { ...current, task: taskFull },
        userId: firstAssignee,
        data: {},
      });
      await uncompleteOccurrence(current.id);
      const pending = await db
        .select()
        .from(taskOccurrences)
        .where(and(eq(taskOccurrences.taskId, task.id), eq(taskOccurrences.status, 'pending')));
      expect(pending).toHaveLength(1);
    }
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

  it('out-of-turn completion with cooldown + points: everything lines up', async () => {
    // User reported the new path "просто отмечает задачу выполненной"
    // — points not credited, cooldown not honoured on the spawned
    // next pending. This test exercises the full chain end-to-end.
    const a = await makeUser();
    const b = await makeUser();
    const { family } = await makeFamily(a);
    await addMember(family, b, 'Adult');

    const task = await createTask({
      familyId: family.id,
      createdBy: a.id,
      data: {
        title: 'Q+points+cooldown',
        type: 'queued',
        schedule: { kind: 'queued' },
        queueUserIds: [a.id, b.id],
        cooldownDays: 3,
        points: 7,
        photoRequired: false,
        singleShot: false,
      },
    });
    const taskFull = (await getTaskInFamily(task.id, family.id))!;

    // Pin current pending on a.
    const firstOcc = (
      await db
        .select()
        .from(taskOccurrences)
        .where(and(eq(taskOccurrences.taskId, task.id), eq(taskOccurrences.status, 'pending')))
    )[0]!;
    await db
      .update(taskOccurrences)
      .set({ assigneeId: a.id })
      .where(eq(taskOccurrences.id, firstOcc.id));
    const reloaded = (
      await db.select().from(taskOccurrences).where(eq(taskOccurrences.id, firstOcc.id))
    )[0]!;

    const completeStart = Date.now();
    await completeOccurrence({
      occurrence: { ...reloaded, task: taskFull },
      userId: b.id,
      data: {},
    });
    const completeEnd = Date.now();

    // 1. completedBy is b.
    const done = (
      await db
        .select()
        .from(taskOccurrences)
        .where(and(eq(taskOccurrences.taskId, task.id), eq(taskOccurrences.status, 'done')))
    )[0]!;
    expect(done.completedBy).toBe(b.id);
    expect(done.pointsAwarded).toBe(7);

    // 2. Points went to b via the ledger — assert b's family balance.
    const { getUserPoints } = await import('../../src/services/rewards');
    const bBalance = await getUserPoints({ familyId: family.id, userId: b.id });
    expect(bBalance).toBe(7);
    const aBalance = await getUserPoints({ familyId: family.id, userId: a.id });
    expect(aBalance).toBe(0);

    // 3. A fresh pending row exists, on a (the skipped user), with
    //    availableAt ~= now + 3 days. This is the "очередь на нем"
    //    auto-correction.
    const next = (
      await db
        .select()
        .from(taskOccurrences)
        .where(and(eq(taskOccurrences.taskId, task.id), eq(taskOccurrences.status, 'pending')))
    )[0]!;
    expect(next.assigneeId).toBe(a.id);
    expect(next.availableAt).not.toBeNull();
    const availMs = next.availableAt!.getTime();
    const expectMin = completeStart + 3 * 86_400_000 - 1000;
    const expectMax = completeEnd + 3 * 86_400_000 + 1000;
    expect(availMs).toBeGreaterThanOrEqual(expectMin);
    expect(availMs).toBeLessThanOrEqual(expectMax);
  });

  it('out-of-turn completion: non-assignee completes, next pending rotates back', async () => {
    // User: "выполнять задачи очереди вне очереди, то есть даже если
    // очередь на ком-то, то можно выполнить самому, а его сдвинет."
    //   - Initial pending is on `a`.
    //   - `b` completes it out-of-turn — completedBy must be `b`, not `a`.
    //   - Next pending must be on `a`: pickNextAssignee sees a=0,b=1
    //     and picks the behind user. The skipped slot auto-corrects.
    const a = await makeUser();
    const b = await makeUser();
    const { family } = await makeFamily(a);
    await addMember(family, b, 'Adult');

    const task = await createTask({
      familyId: family.id,
      createdBy: a.id,
      data: {
        title: 'Out-of-turn',
        type: 'queued',
        schedule: { kind: 'queued' },
        queueUserIds: [a.id, b.id],
        points: 0,
        photoRequired: false,
        singleShot: false,
      },
    });
    const taskFull = (await getTaskInFamily(task.id, family.id))!;

    // Force the current head onto `a` so the rotation start is
    // deterministic regardless of pickNextAssignee's initial pick.
    const firstOcc = (
      await db
        .select()
        .from(taskOccurrences)
        .where(and(eq(taskOccurrences.taskId, task.id), eq(taskOccurrences.status, 'pending')))
    )[0]!;
    await db
      .update(taskOccurrences)
      .set({ assigneeId: a.id })
      .where(eq(taskOccurrences.id, firstOcc.id));
    const reloaded = (
      await db.select().from(taskOccurrences).where(eq(taskOccurrences.id, firstOcc.id))
    )[0]!;

    // `b` completes `a`'s turn.
    await completeOccurrence({
      occurrence: { ...reloaded, task: taskFull },
      userId: b.id,
      data: {},
    });

    // The done row attributes the work to b, not a.
    const done = (
      await db
        .select()
        .from(taskOccurrences)
        .where(and(eq(taskOccurrences.taskId, task.id), eq(taskOccurrences.status, 'done')))
    )[0]!;
    expect(done.completedBy).toBe(b.id);

    // Next pending rotates back to a (behind by completions).
    const next = (
      await db
        .select()
        .from(taskOccurrences)
        .where(and(eq(taskOccurrences.taskId, task.id), eq(taskOccurrences.status, 'pending')))
    )[0]!;
    expect(next.assigneeId).toBe(a.id);
  });
});
