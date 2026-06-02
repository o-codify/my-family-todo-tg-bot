import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client';
import { taskOccurrences } from '../../src/db/schema';
import {
  archiveTask,
  createTask,
  getTaskInFamily,
  restoreTask,
  updateTask,
} from '../../src/services/tasks';
import {
  OccurrenceActionError,
  getOccurrenceInFamily,
  patchOccurrenceSubtasks,
  rescheduleOccurrence,
} from '../../src/services/occurrence-actions';
import { closeDb, makeFamily, makeUser, resetTables } from '../db-helpers';

describe('tasks service (integration)', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('creates a oneoff task with a single occurrence', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);

    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Test',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: futureDate(1) },
        points: 0,
        photoRequired: false,
        singleShot: false,
      },
    });

    const occurrences = await db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, task.id));
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.status).toBe('pending');
  });

  it('propagates schedule.time → scheduledTime on every generated occurrence', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);

    // One-off with a fixed time of day.
    const oneoff = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Timed oneoff',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: futureDate(1), time: '08:30' },
        points: 0,
        photoRequired: false,
        singleShot: false,
      },
    });
    const oneoffOccs = await db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, oneoff.id));
    expect(oneoffOccs[0]?.scheduledTime).toBe('08:30:00');

    // Daily recurring with a time — every generated row carries it.
    const recurring = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Timed daily',
        type: 'recurring',
        schedule: { kind: 'recurring', recurrence: 'daily', time: '21:00' },
        points: 0,
        photoRequired: false,
        singleShot: false,
      },
    });
    const recurringOccs = await db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, recurring.id));
    expect(recurringOccs.length).toBeGreaterThan(0);
    for (const occ of recurringOccs) expect(occ.scheduledTime).toBe('21:00:00');
  });

  it('omits time → scheduledTime stays null', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Untimed',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: futureDate(1) },
        points: 0,
        photoRequired: false,
        singleShot: false,
      },
    });
    const occs = await db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, task.id));
    expect(occs[0]?.scheduledTime).toBeNull();
  });

  it('creates a daily recurring task and materialises a full year of occurrences', async () => {
    // Window bumped from 30 → 365 days so flipping the calendar grid
    // ahead a couple of months still shows dots (user: "календарь
    // должен отображать вообще всё, а не 42 дня").
    const owner = await makeUser();
    const { family } = await makeFamily(owner);

    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Daily',
        type: 'recurring',
        schedule: { kind: 'recurring', recurrence: 'daily' },
        points: 0,
        photoRequired: false,
        singleShot: false,
      },
    });

    const occurrences = await db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, task.id));
    expect(occurrences).toHaveLength(365);
  });

  it('clears future occurrences when schedule changes', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);

    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Switch',
        type: 'recurring',
        schedule: { kind: 'recurring', recurrence: 'daily' },
        points: 0,
        photoRequired: false,
        singleShot: false,
      },
    });

    let occ = await db.select().from(taskOccurrences).where(eq(taskOccurrences.taskId, task.id));
    expect(occ.length).toBe(365);

    const reloaded = await getTaskInFamily(task.id, family.id);
    await updateTask({
      task: reloaded!,
      data: { schedule: { kind: 'recurring', recurrence: 'weekly', daysOfWeek: [1] } },
    });

    occ = await db.select().from(taskOccurrences).where(eq(taskOccurrences.taskId, task.id));
    // 52-53 Mondays in a 365-day window.
    expect(occ.length).toBeGreaterThanOrEqual(52);
    expect(occ.length).toBeLessThanOrEqual(53);
  });

  it('archives task and wipes future occurrences', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);

    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'ToArchive',
        type: 'recurring',
        schedule: { kind: 'recurring', recurrence: 'daily' },
        points: 0,
        photoRequired: false,
        singleShot: false,
      },
    });

    await archiveTask(task.id);

    const occ = await db.select().from(taskOccurrences).where(eq(taskOccurrences.taskId, task.id));
    expect(occ).toHaveLength(0);
  });

  it('restoreTask flips archivedAt back and regenerates occurrences', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);

    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'ToRestore',
        type: 'recurring',
        schedule: { kind: 'recurring', recurrence: 'daily' },
        points: 0,
        photoRequired: false,
        singleShot: false,
      },
    });

    await archiveTask(task.id);
    const restored = await restoreTask(task.id);
    expect(restored).not.toBeNull();
    expect(restored?.archivedAt).toBeNull();

    const occ = await db.select().from(taskOccurrences).where(eq(taskOccurrences.taskId, task.id));
    // Same regen rule as createTask — 30-day window for daily recurring.
    expect(occ.length).toBeGreaterThan(0);
  });

  it('restoreTask is a no-op (idempotent) for a non-archived task', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Live',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: futureDate(1) },
        points: 0,
        photoRequired: false,
        singleShot: false,
      },
    });

    const restored = await restoreTask(task.id);
    expect(restored?.archivedAt).toBeNull();
    // Did not duplicate the occurrence — still exactly one.
    const occ = await db.select().from(taskOccurrences).where(eq(taskOccurrences.taskId, task.id));
    expect(occ).toHaveLength(1);
  });

  it('floating task has no occurrences until completion', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);

    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Buy stuff',
        type: 'floating',
        schedule: { kind: 'floating' },
        points: 0,
        photoRequired: false,
        singleShot: false,
        cooldownDays: 7,
      },
    });

    const occ = await db.select().from(taskOccurrences).where(eq(taskOccurrences.taskId, task.id));
    expect(occ).toHaveLength(0);
  });

  it('seeds subtasks state on occurrences from subtasksTemplate', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);

    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'With subtasks',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: futureDate(1) },
        points: 0,
        photoRequired: false,
        singleShot: false,
        subtasks: [{ title: 'Step 1' }, { title: 'Step 2' }, { title: 'Step 3' }],
      },
    });

    expect(task.subtasksTemplate).toHaveLength(3);
    const [occ] = await db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, task.id));
    expect(occ?.subtasks).toHaveLength(3);
    expect(occ?.subtasks?.every((s) => s.done === false)).toBe(true);
    expect(occ?.subtasks?.map((s) => s.title)).toEqual(['Step 1', 'Step 2', 'Step 3']);
  });

  it('patchOccurrenceSubtasks merges done-state for a subset', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);

    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Multi',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: futureDate(1) },
        points: 0,
        photoRequired: false,
        singleShot: false,
        subtasks: [{ title: 'a' }, { title: 'b' }, { title: 'c' }],
      },
    });
    const [seed] = await db
      .select()
      .from(taskOccurrences)
      .where(and(eq(taskOccurrences.taskId, task.id), eq(taskOccurrences.status, 'pending')));
    const occ = await getOccurrenceInFamily(seed!.id, family.id);
    expect(occ).not.toBeNull();

    // Mark the middle subtask done.
    const middleId = occ!.subtasks![1]!.id;
    const updated = await patchOccurrenceSubtasks({
      occurrence: occ!,
      patch: [{ id: middleId, done: true }],
    });
    expect(updated).not.toBeNull();
    const flips = updated!.subtasks!.map((s) => s.done);
    expect(flips).toEqual([false, true, false]);

    // Toggle it back + flip the first to true.
    const firstId = occ!.subtasks![0]!.id;
    const reloaded = await getOccurrenceInFamily(seed!.id, family.id);
    const updated2 = await patchOccurrenceSubtasks({
      occurrence: reloaded!,
      patch: [
        { id: firstId, done: true },
        { id: middleId, done: false },
      ],
    });
    expect(updated2!.subtasks!.map((s) => s.done)).toEqual([true, false, false]);
  });

  it('rescheduleOccurrence moves a pending occurrence to another date', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Move me',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: futureDate(1) },
        points: 0,
        photoRequired: false,
        singleShot: false,
      },
    });
    const [seed] = await db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, task.id));
    const occ = await getOccurrenceInFamily(seed!.id, family.id);
    const target = futureDate(5);
    const updated = await rescheduleOccurrence({ occurrence: occ!, scheduledDate: target });
    expect(updated.scheduledDate).toBe(target);
  });

  it('rescheduleOccurrence rejects already-done occurrences', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Done already',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: futureDate(1) },
        points: 0,
        photoRequired: false,
        singleShot: false,
      },
    });
    const [seed] = await db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, task.id));
    await db
      .update(taskOccurrences)
      .set({ status: 'done', completedAt: new Date(), completedBy: owner.id })
      .where(eq(taskOccurrences.id, seed!.id));
    const occ = await getOccurrenceInFamily(seed!.id, family.id);
    await expect(
      rescheduleOccurrence({ occurrence: occ!, scheduledDate: futureDate(7) }),
    ).rejects.toBeInstanceOf(OccurrenceActionError);
  });

  it('rescheduleOccurrence surfaces date_conflict on unique violation', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Recurring',
        type: 'recurring',
        schedule: { kind: 'recurring', recurrence: 'daily' },
        points: 0,
        photoRequired: false,
        singleShot: false,
      },
    });
    const rows = await db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, task.id));
    // Pick the row for tomorrow and try to move it onto the day-after-
    // tomorrow's slot, which is already taken by another occurrence.
    const sorted = [...rows].sort((a, b) =>
      (a.scheduledDate ?? '').localeCompare(b.scheduledDate ?? ''),
    );
    const target = sorted[2]?.scheduledDate;
    const first = sorted[1]!;
    expect(target).toBeDefined();
    const occ = await getOccurrenceInFamily(first.id, family.id);
    await expect(
      rescheduleOccurrence({ occurrence: occ!, scheduledDate: target! }),
    ).rejects.toMatchObject({ code: 'date_conflict' });
  });

  it('patchOccurrenceSubtasks returns null when occurrence has no subtasks', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'No subtasks',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: futureDate(1) },
        points: 0,
        photoRequired: false,
        singleShot: false,
      },
    });
    const [seed] = await db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, task.id));
    const occ = await getOccurrenceInFamily(seed!.id, family.id);
    const result = await patchOccurrenceSubtasks({
      occurrence: occ!,
      patch: [{ id: 'fake', done: true }],
    });
    expect(result).toBeNull();
  });
});

function futureDate(daysFromNow: number): string {
  const d = new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}
