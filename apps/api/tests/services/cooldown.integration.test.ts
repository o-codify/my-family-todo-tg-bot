import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client';
import { taskOccurrences, tasks } from '../../src/db/schema';
import { completeFloatingTask, OccurrenceActionError } from '../../src/services/occurrence-actions';
import { createTask, getTaskInFamily } from '../../src/services/tasks';
import { closeDb, makeFamily, makeUser, resetTables } from '../db-helpers';

describe('floating cooldown (integration)', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('archives single-shot floating task on completion', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);

    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Once',
        type: 'floating',
        schedule: { kind: 'floating' },
        points: 0,
        photoRequired: false,
        singleShot: true,
      },
    });

    await completeFloatingTask({ task, userId: owner.id, data: {} });

    const reloaded = await getTaskInFamily(task.id, family.id);
    expect(reloaded?.archivedAt).not.toBeNull();
  });

  it('creates pending occurrence with availableAt after cooldown', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);

    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Sugar',
        type: 'floating',
        schedule: { kind: 'floating' },
        points: 0,
        photoRequired: false,
        singleShot: false,
        cooldownDays: 7,
      },
    });

    const before = Date.now();
    await completeFloatingTask({ task, userId: owner.id, data: {} });

    const pending = await db
      .select()
      .from(taskOccurrences)
      .where(and(eq(taskOccurrences.taskId, task.id), eq(taskOccurrences.status, 'pending')));
    expect(pending).toHaveLength(1);
    expect(pending[0]?.availableAt).not.toBeNull();
    const diffMs = pending[0]!.availableAt!.getTime() - before;
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    // Allow ±2s slack
    expect(diffMs).toBeGreaterThan(sevenDays - 2_000);
    expect(diffMs).toBeLessThan(sevenDays + 2_000);
  });

  it('reopens immediately when no cooldown and not single_shot', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);

    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'NoCD',
        type: 'floating',
        schedule: { kind: 'floating' },
        points: 0,
        photoRequired: false,
        singleShot: false,
      },
    });

    await completeFloatingTask({ task, userId: owner.id, data: {} });

    const pending = await db
      .select()
      .from(taskOccurrences)
      .where(and(eq(taskOccurrences.taskId, task.id), eq(taskOccurrences.status, 'pending')));
    expect(pending).toHaveLength(1);
    expect(pending[0]?.availableAt).toBeNull();
  });

  it('blocks completion while cooldown active', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);

    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Sugar2',
        type: 'floating',
        schedule: { kind: 'floating' },
        points: 0,
        photoRequired: false,
        singleShot: false,
        cooldownDays: 30,
      },
    });

    await completeFloatingTask({ task, userId: owner.id, data: {} });
    await expect(
      completeFloatingTask({ task, userId: owner.id, data: {} }),
    ).rejects.toBeInstanceOf(OccurrenceActionError);
  });

  it('allows completing a floating task twice in the same day (no cooldown)', async () => {
    // Regression for the 500 reported on /complete-floating. When the task
    // has no cooldown the service reopens a fresh pending occurrence after
    // each completion; without the fix the second completion's "set
    // scheduledDate = today" violated the (task_id, scheduled_date) unique
    // index because the previously-completed row already held that key.
    const owner = await makeUser();
    const { family } = await makeFamily(owner);

    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'twice-today',
        type: 'floating',
        schedule: { kind: 'floating' },
        points: 0,
        photoRequired: false,
        singleShot: false,
      },
    });

    await completeFloatingTask({ task, userId: owner.id, data: {} });
    await expect(
      completeFloatingTask({ task, userId: owner.id, data: {} }),
    ).resolves.toBeDefined();

    const allDone = await db
      .select()
      .from(taskOccurrences)
      .where(and(eq(taskOccurrences.taskId, task.id), eq(taskOccurrences.status, 'done')));
    expect(allDone).toHaveLength(2);
  });

  it('awards points to the completer when task.points > 0', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);

    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'with-points',
        type: 'floating',
        schedule: { kind: 'floating' },
        points: 7,
        photoRequired: false,
        singleShot: false,
      },
    });

    await completeFloatingTask({ task, userId: owner.id, data: {} });

    // Sanity: a points-ledger row must exist for the completion. Regression
    // guard against the bug where completeFloatingTask did a raw insert into
    // pointsLedger via dynamic-import inside a transaction (returned 500 in
    // prod because the schema module wasn't part of the tx's drizzle scope).
    const { pointsLedger } = await import('../../src/db/schema');
    const rows = await db.select().from(pointsLedger).where(eq(pointsLedger.userId, owner.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.delta).toBe(7);
    expect(rows[0]?.reason).toBe('task_completed');
  });

  it('rejects when photoRequired and no photos given', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);

    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'photo-required',
        type: 'floating',
        schedule: { kind: 'floating' },
        points: 0,
        photoRequired: true,
        singleShot: false,
      },
    });

    await expect(
      completeFloatingTask({ task, userId: owner.id, data: {} }),
    ).rejects.toMatchObject({ code: 'photo_required' });

    // ensure task not archived
    const reloaded = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(reloaded[0]?.archivedAt).toBeNull();
  });
});
