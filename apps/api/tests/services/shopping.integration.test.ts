import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client';
import { shoppingItems } from '../../src/db/schema';
import {
  addItem,
  addItemsBulk,
  archiveBought,
  deleteItem,
  ensurePrimaryList,
  getPrimaryListWithItems,
  restoreItem,
  updateItem,
} from '../../src/services/shopping';
import { closeDb, makeFamily, makeUser, resetTables } from '../db-helpers';

describe('shopping list (integration)', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('ensures a primary list lazily — and reuses it on subsequent calls', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const a = await ensurePrimaryList(family.id);
    const b = await ensurePrimaryList(family.id);
    expect(a.id).toBe(b.id);
    expect(a.isPrimary).toBe('true');
  });

  it('adds items in append order via incrementing position', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const list = await ensurePrimaryList(family.id);
    const it1 = await addItem({
      familyId: family.id,
      listId: list.id,
      userId: owner.id,
      data: { text: 'Молоко', category: 'dairy' },
    });
    const it2 = await addItem({
      familyId: family.id,
      listId: list.id,
      userId: owner.id,
      data: { text: 'Хлеб', category: 'bakery' },
    });
    expect(it1.position).toBeLessThan(it2.position);
  });

  it('marking bought stamps boughtBy + boughtAt; unbuy clears them', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const list = await ensurePrimaryList(family.id);
    const item = await addItem({
      familyId: family.id,
      listId: list.id,
      userId: owner.id,
      data: { text: 'Молоко', category: 'dairy' },
    });
    const bought = await updateItem({
      familyId: family.id,
      itemId: item.id,
      userId: owner.id,
      patch: { status: 'bought' },
    });
    expect(bought?.status).toBe('bought');
    expect(bought?.boughtByUserId).toBe(owner.id);
    expect(bought?.boughtAt).not.toBeNull();

    const unbought = await updateItem({
      familyId: family.id,
      itemId: item.id,
      userId: owner.id,
      patch: { status: 'open' },
    });
    expect(unbought?.status).toBe('open');
    expect(unbought?.boughtByUserId).toBeNull();
    expect(unbought?.boughtAt).toBeNull();
  });

  it('soft-delete + restore round-trips', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const list = await ensurePrimaryList(family.id);
    const item = await addItem({
      familyId: family.id,
      listId: list.id,
      userId: owner.id,
      data: { text: 'Молоко', category: 'dairy' },
    });
    expect(await deleteItem({ familyId: family.id, itemId: item.id })).toBe(true);
    let { items } = await getPrimaryListWithItems(family.id);
    expect(items).toHaveLength(0); // deleted hidden from list

    const restored = await restoreItem({ familyId: family.id, itemId: item.id });
    expect(restored?.deletedAt).toBeNull();
    ({ items } = await getPrimaryListWithItems(family.id));
    expect(items).toHaveLength(1);
  });

  it('bulk add skips duplicate texts of existing OPEN items (case-insensitive)', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const list = await ensurePrimaryList(family.id);
    await addItem({
      familyId: family.id,
      listId: list.id,
      userId: owner.id,
      data: { text: 'Молоко', category: 'dairy' },
    });
    const { added, skipped } = await addItemsBulk({
      familyId: family.id,
      listId: list.id,
      userId: owner.id,
      items: [
        { text: 'молоко', category: 'dairy' }, // dup (case-insensitive)
        { text: 'Хлеб', category: 'bakery' }, // new
      ],
    });
    expect(added).toHaveLength(1);
    expect(skipped).toBe(1);
    expect(added[0]?.text).toBe('Хлеб');
  });

  it('bulk add allows duplicating a previously-BOUGHT item (new purchase)', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const list = await ensurePrimaryList(family.id);
    const item = await addItem({
      familyId: family.id,
      listId: list.id,
      userId: owner.id,
      data: { text: 'Молоко', category: 'dairy' },
    });
    await updateItem({
      familyId: family.id,
      itemId: item.id,
      userId: owner.id,
      patch: { status: 'bought' },
    });
    // Bought row exists but bulk-add of same text should NOT be skipped
    // because the open-row dedupe only blocks OPEN duplicates.
    const { added, skipped } = await addItemsBulk({
      familyId: family.id,
      listId: list.id,
      userId: owner.id,
      items: [{ text: 'Молоко', category: 'dairy' }],
    });
    expect(added).toHaveLength(1);
    expect(skipped).toBe(0);
  });

  it('archiveBought sweeps bought items into soft-deleted state', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const list = await ensurePrimaryList(family.id);
    const a = await addItem({
      familyId: family.id,
      listId: list.id,
      userId: owner.id,
      data: { text: 'Молоко', category: 'dairy' },
    });
    const b = await addItem({
      familyId: family.id,
      listId: list.id,
      userId: owner.id,
      data: { text: 'Хлеб', category: 'bakery' },
    });
    await updateItem({
      familyId: family.id,
      itemId: a.id,
      userId: owner.id,
      patch: { status: 'bought' },
    });
    // b stays open
    const archived = await archiveBought({
      familyId: family.id,
      listId: list.id,
      olderThanDays: 0,
    });
    expect(archived).toBe(1);

    const all = await db.select().from(shoppingItems).where(eq(shoppingItems.listId, list.id));
    const aRow = all.find((r) => r.id === a.id);
    const bRow = all.find((r) => r.id === b.id);
    expect(aRow?.deletedAt).not.toBeNull();
    expect(bRow?.deletedAt).toBeNull();
  });
});
