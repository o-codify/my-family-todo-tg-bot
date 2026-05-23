import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client';
import { taskOccurrences } from '../../src/db/schema';
import {
  getOccurrenceInFamily,
  OccurrenceActionError,
  patchOccurrenceSubtasks,
} from '../../src/services/occurrence-actions';
import { createTask } from '../../src/services/tasks';
import { closeDb, makeFamily, makeUser, resetTables } from '../db-helpers';

function isoTomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe('quests / sequential subtasks (integration)', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('quest mode: ticking step 1 then step 2 succeeds', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Morning routine',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow() },
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
        isQuest: true,
        subtasks: [{ title: 'Brush teeth' }, { title: 'Make bed' }, { title: 'Eat' }],
      },
    });
    const occRows = await db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, task.id));
    const occ = await getOccurrenceInFamily(occRows[0]!.id, family.id);
    const step1 = occ!.subtasks![0]!;
    const step2 = occ!.subtasks![1]!;

    const after1 = await patchOccurrenceSubtasks({
      occurrence: occ!,
      patch: [{ id: step1.id, done: true }],
    });
    expect(after1?.subtasks?.[0]?.done).toBe(true);

    // Reload, since merge starts from `occurrence.subtasks`.
    const reloaded = await getOccurrenceInFamily(occRows[0]!.id, family.id);
    const after2 = await patchOccurrenceSubtasks({
      occurrence: reloaded!,
      patch: [{ id: step2.id, done: true }],
    });
    expect(after2?.subtasks?.[1]?.done).toBe(true);
  });

  it('quest mode: skipping step 1 to tick step 2 throws out_of_order', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Routine',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow() },
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
        isQuest: true,
        subtasks: [{ title: 'A' }, { title: 'B' }],
      },
    });
    const occRows = await db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, task.id));
    const occ = await getOccurrenceInFamily(occRows[0]!.id, family.id);
    const step2 = occ!.subtasks![1]!;
    await expect(
      patchOccurrenceSubtasks({
        occurrence: occ!,
        patch: [{ id: step2.id, done: true }],
      }),
    ).rejects.toBeInstanceOf(OccurrenceActionError);
  });

  it('non-quest task: any-order ticks are allowed', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Checklist',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow() },
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
        isQuest: false,
        subtasks: [{ title: 'A' }, { title: 'B' }],
      },
    });
    const occRows = await db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, task.id));
    const occ = await getOccurrenceInFamily(occRows[0]!.id, family.id);
    const step2 = occ!.subtasks![1]!;
    // Ticking step 2 first is fine on a non-quest task.
    const after = await patchOccurrenceSubtasks({
      occurrence: occ!,
      patch: [{ id: step2.id, done: true }],
    });
    expect(after?.subtasks?.[1]?.done).toBe(true);
  });

  it('quest mode: untick is always allowed regardless of order', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Routine',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow() },
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
        isQuest: true,
        subtasks: [{ title: 'A' }, { title: 'B' }],
      },
    });
    const occRows = await db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, task.id));
    const occ = await getOccurrenceInFamily(occRows[0]!.id, family.id);
    const step1 = occ!.subtasks![0]!;
    await patchOccurrenceSubtasks({
      occurrence: occ!,
      patch: [{ id: step1.id, done: true }],
    });
    const reloaded = await getOccurrenceInFamily(occRows[0]!.id, family.id);
    // Untick allowed without checking order.
    const after = await patchOccurrenceSubtasks({
      occurrence: reloaded!,
      patch: [{ id: step1.id, done: false }],
    });
    expect(after?.subtasks?.[0]?.done).toBe(false);
  });
});
