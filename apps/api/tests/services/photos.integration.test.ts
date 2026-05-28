import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client';
import { taskPhotos, taskOccurrences } from '../../src/db/schema';
import { listPhotosForFamily } from '../../src/services/photos';
import { createTask } from '../../src/services/tasks';
import { closeDb, makeFamily, makeUser, resetTables } from '../db-helpers';

function isoTomorrow(offset = 1): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

describe('listPhotosForFamily input guards (integration)', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('clamps a NaN limit and ignores an unparseable before cursor', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Photo task',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow(1) },
        assigneeId: owner.id,
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    const occ = (
      await db.select().from(taskOccurrences).where(eq(taskOccurrences.taskId, task.id))
    )[0]!;
    await db.insert(taskPhotos).values([
      { taskId: task.id, occurrenceId: occ.id, userId: owner.id, telegramFileId: 'f1', telegramChatId: 1 },
      { taskId: task.id, occurrenceId: occ.id, userId: owner.id, telegramFileId: 'f2', telegramChatId: 1 },
    ]);

    // NaN limit (Number("abc")) + garbage cursor must not throw and must
    // still return the rows (limit clamped to default, cursor ignored).
    const rows = await listPhotosForFamily({
      familyId: family.id,
      limit: Number('abc'),
      beforeIso: 'not-a-date',
    });
    expect(rows).toHaveLength(2);
  });

  it('applies a valid before cursor', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Photo task',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow(1) },
        assigneeId: owner.id,
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    await db.insert(taskPhotos).values({
      taskId: task.id,
      userId: owner.id,
      telegramFileId: 'f1',
      telegramChatId: 1,
    });

    // Cursor in the past → excludes the just-created row.
    const rows = await listPhotosForFamily({
      familyId: family.id,
      beforeIso: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(rows).toHaveLength(0);
  });
});
