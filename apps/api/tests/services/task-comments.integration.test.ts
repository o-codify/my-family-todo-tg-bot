import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createComment,
  deleteComment,
  listComments,
} from '../../src/services/task-comments';
import { createTask } from '../../src/services/tasks';
import { closeDb, makeFamily, makeUser, resetTables } from '../db-helpers';

function isoTomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe('task comments (integration)', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('creates and lists in chronological order', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Test',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow() },
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    const a = await createComment({
      taskId: task.id,
      userId: owner.id,
      data: { text: 'first' },
    });
    // Tiny gap so createdAt timestamps differ.
    await new Promise((r) => setTimeout(r, 5));
    const b = await createComment({
      taskId: task.id,
      userId: owner.id,
      data: { text: 'second' },
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const rows = await listComments({ taskId: task.id });
    expect(rows.map((r) => r.text)).toEqual(['first', 'second']);
  });

  it('soft-delete only by the author', async () => {
    const owner = await makeUser();
    const kid = await makeUser({ firstName: 'Kid' });
    const { family } = await makeFamily(owner);
    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Test',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow() },
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    const c = await createComment({
      taskId: task.id,
      userId: owner.id,
      data: { text: 'mine' },
    });
    // Wrong user can't delete.
    const r1 = await deleteComment({ commentId: c!.id, userId: kid.id });
    expect(r1.ok).toBe(false);
    // Author can.
    const r2 = await deleteComment({ commentId: c!.id, userId: owner.id });
    expect(r2.ok).toBe(true);
    const after = await listComments({ taskId: task.id });
    expect(after).toHaveLength(0);
  });

  it('createComment returns null for an unknown task', async () => {
    const owner = await makeUser();
    await makeFamily(owner);
    const row = await createComment({
      taskId: '00000000-0000-0000-0000-000000000000',
      userId: owner.id,
      data: { text: 'orphan' },
    });
    expect(row).toBeNull();
  });
});
