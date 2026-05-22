import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TagServiceError,
  createTag,
  deleteTag,
  getTagIdsForTasks,
  listTagsForFamily,
  setTaskTags,
  updateTag,
} from '../../src/services/tags';
import { createTask } from '../../src/services/tasks';
import { closeDb, makeFamily, makeUser, resetTables } from '../db-helpers';

describe('tags service (integration)', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('creates a tag and lists it back', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const created = await createTag({ familyId: family.id, name: 'Кухня', color: '#FF6B6B' });
    expect(created.name).toBe('Кухня');
    expect(created.color).toBe('#FF6B6B');
    const all = await listTagsForFamily(family.id);
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(created.id);
  });

  it('rejects duplicate name (case-insensitive) within a family', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    await createTag({ familyId: family.id, name: 'Кухня', color: null });
    await expect(
      createTag({ familyId: family.id, name: 'КУХНЯ', color: null }),
    ).rejects.toBeInstanceOf(TagServiceError);
  });

  it('allows the same name in different families', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const famA = (await makeFamily(a)).family;
    const famB = (await makeFamily(b)).family;
    await createTag({ familyId: famA.id, name: 'Кухня', color: null });
    // Should not throw — uniqueness is scoped per-family.
    const created = await createTag({ familyId: famB.id, name: 'Кухня', color: null });
    expect(created.familyId).toBe(famB.id);
  });

  it('setTaskTags replaces the join rows (idempotent + clears)', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const tag1 = await createTag({ familyId: family.id, name: 'one', color: null });
    const tag2 = await createTag({ familyId: family.id, name: 'two', color: null });
    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'T',
        type: 'floating',
        schedule: { kind: 'floating' },
        points: 0,
        photoRequired: false,
        singleShot: false,
      },
    });
    await setTaskTags(task.id, [tag1.id, tag2.id]);
    let mapped = await getTagIdsForTasks([task.id]);
    expect(mapped.get(task.id)?.sort()).toEqual([tag1.id, tag2.id].sort());

    // Idempotent: same call yields same set.
    await setTaskTags(task.id, [tag1.id, tag2.id]);
    mapped = await getTagIdsForTasks([task.id]);
    expect(mapped.get(task.id)?.sort()).toEqual([tag1.id, tag2.id].sort());

    // Reducing the set drops the missing ones.
    await setTaskTags(task.id, [tag1.id]);
    mapped = await getTagIdsForTasks([task.id]);
    expect(mapped.get(task.id)).toEqual([tag1.id]);

    // Empty clears all.
    await setTaskTags(task.id, []);
    mapped = await getTagIdsForTasks([task.id]);
    expect(mapped.get(task.id) ?? []).toEqual([]);
  });

  it('createTask accepts tagIds and persists the attachments', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const tag = await createTag({ familyId: family.id, name: 'Дом', color: null });
    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Test',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: '2030-01-01' },
        points: 0,
        photoRequired: false,
        singleShot: false,
        tagIds: [tag.id],
      },
    });
    const mapped = await getTagIdsForTasks([task.id]);
    expect(mapped.get(task.id)).toEqual([tag.id]);
  });

  it('deleting a tag cascades to its task_tags rows', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const tag = await createTag({ familyId: family.id, name: 'Tmp', color: null });
    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'T',
        type: 'floating',
        schedule: { kind: 'floating' },
        points: 0,
        photoRequired: false,
        singleShot: false,
        tagIds: [tag.id],
      },
    });
    expect((await getTagIdsForTasks([task.id])).get(task.id)).toEqual([tag.id]);

    const ok = await deleteTag({ tagId: tag.id, familyId: family.id });
    expect(ok).toBe(true);
    expect((await getTagIdsForTasks([task.id])).get(task.id) ?? []).toEqual([]);
  });

  it('updateTag enforces uniqueness on rename', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const a = await createTag({ familyId: family.id, name: 'A', color: null });
    await createTag({ familyId: family.id, name: 'B', color: null });
    await expect(
      updateTag({ tagId: a.id, familyId: family.id, patch: { name: 'b' } }),
    ).rejects.toBeInstanceOf(TagServiceError);
  });
});
