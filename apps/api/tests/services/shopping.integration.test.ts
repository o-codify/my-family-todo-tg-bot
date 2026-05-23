import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client';
import { catalogItems, shoppingItems, tasks } from '../../src/db/schema';
import {
  addCatalogItemsToList,
  addItem,
  archiveList,
  createList,
  getListWithItems,
  listLists,
  moveItem,
  updateItem,
  updateList,
} from '../../src/services/shopping';
import { closeDb, makeFamily, makeUser, resetTables } from '../db-helpers';

describe('shopping rework (integration)', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('creates a list and lists it back', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const list = await createList({
      familyId: family.id,
      userId: owner.id,
      data: { name: 'Тест' },
    });
    expect(list.name).toBe('Тест');
    const all = await listLists({ familyId: family.id });
    expect(all).toHaveLength(1);
    expect(all[0]?.openCount).toBe(0);
  });

  it('addItem auto-promotes free text to a catalog row', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const list = await createList({
      familyId: family.id,
      userId: owner.id,
      data: { name: 'X' },
    });
    const item = await addItem({
      familyId: family.id,
      listId: list.id,
      userId: owner.id,
      data: { text: 'Молоко', category: 'dairy' },
    });
    expect(item.catalogItemId).not.toBeNull();
    const cat = await db.query.catalogItems.findFirst({
      where: eq(catalogItems.id, item.catalogItemId!),
    });
    expect(cat?.name).toBe('Молоко');
  });

  it('addItem reuses an existing catalog row case-insensitively', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const [seed] = await db
      .insert(catalogItems)
      .values({ familyId: family.id, name: 'Хлеб', createdBy: owner.id })
      .returning();
    const list = await createList({
      familyId: family.id,
      userId: owner.id,
      data: { name: 'X' },
    });
    const item = await addItem({
      familyId: family.id,
      listId: list.id,
      userId: owner.id,
      data: { text: 'хлеб', category: 'bakery' },
    });
    expect(item.catalogItemId).toBe(seed!.id);
  });

  it('addCatalogItemsToList dedupes against existing OPEN items', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const list = await createList({
      familyId: family.id,
      userId: owner.id,
      data: { name: 'X' },
    });
    const [cat1] = await db
      .insert(catalogItems)
      .values({ familyId: family.id, name: 'Сыр', createdBy: owner.id })
      .returning();
    const [cat2] = await db
      .insert(catalogItems)
      .values({ familyId: family.id, name: 'Мёд', createdBy: owner.id })
      .returning();
    await addCatalogItemsToList({
      familyId: family.id,
      listId: list.id,
      userId: owner.id,
      catalogItemIds: [cat1!.id, cat2!.id],
    });
    const { added, skipped } = await addCatalogItemsToList({
      familyId: family.id,
      listId: list.id,
      userId: owner.id,
      catalogItemIds: [cat1!.id, cat2!.id],
    });
    expect(added).toHaveLength(0);
    expect(skipped).toBe(2);
  });

  it('moveItem reassigns the item to the target list', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const a = await createList({
      familyId: family.id,
      userId: owner.id,
      data: { name: 'A' },
    });
    const b = await createList({
      familyId: family.id,
      userId: owner.id,
      data: { name: 'B' },
    });
    const item = await addItem({
      familyId: family.id,
      listId: a.id,
      userId: owner.id,
      data: { text: 'Молоко', category: 'dairy' },
    });
    const moved = await moveItem({
      familyId: family.id,
      itemId: item.id,
      targetListId: b.id,
    });
    expect(moved?.listId).toBe(b.id);
  });

  it('moveItem refuses cross-family targets', async () => {
    const ownerA = await makeUser();
    const ownerB = await makeUser({ firstName: 'B' });
    const { family: famA } = await makeFamily(ownerA);
    const { family: famB } = await makeFamily(ownerB);
    const listA = await createList({
      familyId: famA.id,
      userId: ownerA.id,
      data: { name: 'A' },
    });
    const listB = await createList({
      familyId: famB.id,
      userId: ownerB.id,
      data: { name: 'B' },
    });
    const item = await addItem({
      familyId: famA.id,
      listId: listA.id,
      userId: ownerA.id,
      data: { text: 'Молоко', category: 'dairy' },
    });
    const moved = await moveItem({
      familyId: famA.id,
      itemId: item.id,
      targetListId: listB.id,
    });
    expect(moved).toBeNull();
  });

  it('updateList with dueDate creates a backing task; clearing drops it', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const list = await createList({
      familyId: family.id,
      userId: owner.id,
      data: { name: 'X' },
    });
    const dated = await updateList({
      familyId: family.id,
      listId: list.id,
      userId: owner.id,
      patch: { dueDate: '2027-01-15' },
    });
    expect(dated?.taskId).not.toBeNull();
    const t = await db.query.tasks.findFirst({
      where: eq(tasks.id, dated!.taskId!),
    });
    expect(t?.title).toContain('X');

    const cleared = await updateList({
      familyId: family.id,
      listId: list.id,
      userId: owner.id,
      patch: { dueDate: null },
    });
    expect(cleared?.taskId).toBeNull();
    // Task is archived, not deleted.
    const tAfter = await db.query.tasks.findFirst({
      where: eq(tasks.id, dated!.taskId!),
    });
    expect(tAfter?.archivedAt).not.toBeNull();
  });

  it('archiveList hides it from listLists and drops the backing task', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const list = await createList({
      familyId: family.id,
      userId: owner.id,
      data: { name: 'X', dueDate: '2027-02-01' },
    });
    expect(list.taskId).not.toBeNull();
    await archiveList({ familyId: family.id, listId: list.id });
    const after = await listLists({ familyId: family.id });
    expect(after).toHaveLength(0);
    const tAfter = await db.query.tasks.findFirst({
      where: eq(tasks.id, list.taskId!),
    });
    expect(tAfter?.archivedAt).not.toBeNull();
  });

  it('updateItem flipping to bought stamps boughtBy + boughtAt', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const list = await createList({
      familyId: family.id,
      userId: owner.id,
      data: { name: 'X' },
    });
    const item = await addItem({
      familyId: family.id,
      listId: list.id,
      userId: owner.id,
      data: { text: 'Молоко', category: 'dairy' },
    });
    const after = await updateItem({
      familyId: family.id,
      itemId: item.id,
      userId: owner.id,
      patch: { status: 'bought' },
    });
    expect(after?.boughtByUserId).toBe(owner.id);
    expect(after?.boughtAt).not.toBeNull();
  });

  it('getListWithItems returns the list with non-deleted items', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const list = await createList({
      familyId: family.id,
      userId: owner.id,
      data: { name: 'X' },
    });
    await addItem({
      familyId: family.id,
      listId: list.id,
      userId: owner.id,
      data: { text: 'A', category: 'other' },
    });
    const item2 = await addItem({
      familyId: family.id,
      listId: list.id,
      userId: owner.id,
      data: { text: 'B', category: 'other' },
    });
    // Soft-delete one.
    await db
      .update(shoppingItems)
      .set({ deletedAt: new Date() })
      .where(eq(shoppingItems.id, item2.id));
    const result = await getListWithItems({ familyId: family.id, listId: list.id });
    expect(result?.items).toHaveLength(1);
  });
});
