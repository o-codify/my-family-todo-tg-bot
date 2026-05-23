import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createEntry,
  deleteEntry,
  listEntries,
  pushToShoppingList,
  restoreEntry,
  updateEntry,
} from '../../src/services/meal-plan';
import {
  createList,
  getListWithItems,
} from '../../src/services/shopping';
import { closeDb, makeFamily, makeUser, resetTables } from '../db-helpers';

describe('meal plan (integration)', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('creates an entry and lists it within range', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const ent = await createEntry({
      familyId: family.id,
      userId: owner.id,
      data: { date: '2026-05-20', slot: 'dinner', title: 'Pasta' },
    });
    expect(ent.title).toBe('Pasta');

    const rows = await listEntries({
      familyId: family.id,
      from: '2026-05-19',
      to: '2026-05-21',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(ent.id);
  });

  it('creating a second entry at the same (date, slot) replaces the first', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const a = await createEntry({
      familyId: family.id,
      userId: owner.id,
      data: { date: '2026-05-20', slot: 'dinner', title: 'Pasta' },
    });
    const b = await createEntry({
      familyId: family.id,
      userId: owner.id,
      data: { date: '2026-05-20', slot: 'dinner', title: 'Soup' },
    });
    expect(a.id).not.toBe(b.id);

    const rows = await listEntries({
      familyId: family.id,
      from: '2026-05-20',
      to: '2026-05-20',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Soup');
  });

  it('updates patch only provided fields', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const ent = await createEntry({
      familyId: family.id,
      userId: owner.id,
      data: { date: '2026-05-20', slot: 'dinner', title: 'Pasta', notes: 'rough plan' },
    });
    const updated = await updateEntry({
      familyId: family.id,
      entryId: ent.id,
      patch: { title: 'Carbonara' },
    });
    expect(updated?.title).toBe('Carbonara');
    expect(updated?.notes).toBe('rough plan');
  });

  it('soft-delete + restore round-trips', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const ent = await createEntry({
      familyId: family.id,
      userId: owner.id,
      data: { date: '2026-05-20', slot: 'dinner', title: 'Pasta' },
    });
    expect(await deleteEntry({ familyId: family.id, entryId: ent.id })).toBe(true);
    let rows = await listEntries({
      familyId: family.id,
      from: '2026-05-20',
      to: '2026-05-20',
    });
    expect(rows).toHaveLength(0);
    const restored = await restoreEntry({ familyId: family.id, entryId: ent.id });
    expect(restored?.deletedAt).toBeNull();
    rows = await listEntries({
      familyId: family.id,
      from: '2026-05-20',
      to: '2026-05-20',
    });
    expect(rows).toHaveLength(1);
  });

  it('pushToShoppingList adds ingredients as open items in target list', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const list = await createList({
      familyId: family.id,
      userId: owner.id,
      data: { name: 'Покупки' },
    });
    const ent = await createEntry({
      familyId: family.id,
      userId: owner.id,
      data: {
        date: '2026-05-20',
        slot: 'dinner',
        title: 'Pasta',
        ingredients: [
          { text: 'Паста' },
          { text: 'Помидоры', quantity: '500 г' },
          { text: 'Базилик' },
        ],
      },
    });
    const result = await pushToShoppingList({
      familyId: family.id,
      userId: owner.id,
      entryId: ent.id,
      listId: list.id,
    });
    expect(result).toEqual({ added: 3, skipped: 0 });

    const result2 = await getListWithItems({ familyId: family.id, listId: list.id });
    expect(result2?.items.map((i) => i.text).sort()).toEqual(
      ['Базилик', 'Паста', 'Помидоры'].sort(),
    );
  });

  it('pushToShoppingList dedups against existing open items', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const list = await createList({
      familyId: family.id,
      userId: owner.id,
      data: { name: 'Покупки' },
    });
    // Pre-populate shopping list with "Паста".
    const { addItem } = await import('../../src/services/shopping');
    await addItem({
      familyId: family.id,
      listId: list.id,
      userId: owner.id,
      data: { text: 'Паста', category: 'other' },
    });

    const ent = await createEntry({
      familyId: family.id,
      userId: owner.id,
      data: {
        date: '2026-05-20',
        slot: 'dinner',
        title: 'Pasta',
        ingredients: [{ text: 'Паста' }, { text: 'Помидоры' }],
      },
    });
    const result = await pushToShoppingList({
      familyId: family.id,
      userId: owner.id,
      entryId: ent.id,
      listId: list.id,
    });
    expect(result).toEqual({ added: 1, skipped: 1 });
  });

  it('pushToShoppingList on entry without ingredients returns 0/0', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const ent = await createEntry({
      familyId: family.id,
      userId: owner.id,
      data: { date: '2026-05-20', slot: 'dinner', title: 'Pasta' },
    });
    const result = await pushToShoppingList({
      familyId: family.id,
      userId: owner.id,
      entryId: ent.id,
    });
    expect(result).toEqual({ added: 0, skipped: 0 });
  });
});
