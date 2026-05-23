import { and, asc, eq, gte, isNull, lte } from 'drizzle-orm';
import type {
  CreateMealPlanEntryInput,
  MealPlanSlot,
  UpdateMealPlanEntryInput,
} from '@family-todo/shared';
import { db } from '../db/client';
import { mealPlanEntries, type MealPlanEntryRow } from '../db/schema';
import { publishFamilyEvent } from '../realtime/pubsub';
import { addItemsBulk, ensurePrimaryList } from './shopping';

/**
 * Meal plan service.
 *
 * Stores one row per (family, date, slot). Re-using a slot replaces the
 * previous title (via soft-delete of the old row + insert of the new
 * one). This keeps the row history intact in case someone hits "undo"
 * after replacing a meal.
 *
 * The headline feature is `pushToShoppingList` — takes an entry's
 * ingredients and bulk-inserts them into the family's shopping list.
 * That's the killer reason families ask for meal planning: "we wrote
 * down what we're cooking, now make the grocery list please".
 */

export async function listEntries(input: {
  familyId: string;
  from: string;
  to: string;
}): Promise<MealPlanEntryRow[]> {
  return db
    .select()
    .from(mealPlanEntries)
    .where(
      and(
        eq(mealPlanEntries.familyId, input.familyId),
        gte(mealPlanEntries.date, input.from),
        lte(mealPlanEntries.date, input.to),
        isNull(mealPlanEntries.deletedAt),
      ),
    )
    .orderBy(asc(mealPlanEntries.date), asc(mealPlanEntries.slot));
}

export async function createEntry(input: {
  familyId: string;
  userId: string;
  data: CreateMealPlanEntryInput;
}): Promise<MealPlanEntryRow> {
  // If a row already exists for this (family, date, slot), soft-delete
  // it first so the new title cleanly replaces. Soft-deleted rows are
  // skipped by the partial unique index, so the new insert won't trip.
  await db
    .update(mealPlanEntries)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(mealPlanEntries.familyId, input.familyId),
        eq(mealPlanEntries.date, input.data.date),
        eq(mealPlanEntries.slot, input.data.slot),
        isNull(mealPlanEntries.deletedAt),
      ),
    );
  const [row] = await db
    .insert(mealPlanEntries)
    .values({
      familyId: input.familyId,
      date: input.data.date,
      slot: input.data.slot,
      title: input.data.title,
      notes: input.data.notes ?? null,
      ingredients: input.data.ingredients ?? [],
      createdByUserId: input.userId,
    })
    .returning();
  void publishFamilyEvent(input.familyId, { kind: 'invalidate', scope: 'meal-plan' });
  return row!;
}

export async function updateEntry(input: {
  familyId: string;
  entryId: string;
  patch: UpdateMealPlanEntryInput;
}): Promise<MealPlanEntryRow | null> {
  const next: Partial<typeof mealPlanEntries.$inferInsert> = {};
  if (input.patch.date !== undefined) next.date = input.patch.date;
  if (input.patch.slot !== undefined) next.slot = input.patch.slot;
  if (input.patch.title !== undefined) next.title = input.patch.title;
  if (input.patch.notes !== undefined) next.notes = input.patch.notes;
  if (input.patch.ingredients !== undefined) next.ingredients = input.patch.ingredients;
  if (Object.keys(next).length === 0) {
    const existing = await db.query.mealPlanEntries.findFirst({
      where: eq(mealPlanEntries.id, input.entryId),
    });
    return existing ?? null;
  }
  next.updatedAt = new Date();
  const [row] = await db
    .update(mealPlanEntries)
    .set(next)
    .where(eq(mealPlanEntries.id, input.entryId))
    .returning();
  if (row)
    void publishFamilyEvent(input.familyId, { kind: 'invalidate', scope: 'meal-plan' });
  return row ?? null;
}

export async function deleteEntry(input: {
  familyId: string;
  entryId: string;
}): Promise<boolean> {
  const res = await db
    .update(mealPlanEntries)
    .set({ deletedAt: new Date() })
    .where(and(eq(mealPlanEntries.id, input.entryId), isNull(mealPlanEntries.deletedAt)))
    .returning({ id: mealPlanEntries.id });
  if (res.length > 0) {
    void publishFamilyEvent(input.familyId, { kind: 'invalidate', scope: 'meal-plan' });
  }
  return res.length > 0;
}

export async function restoreEntry(input: {
  familyId: string;
  entryId: string;
}): Promise<MealPlanEntryRow | null> {
  const [row] = await db
    .update(mealPlanEntries)
    .set({ deletedAt: null })
    .where(eq(mealPlanEntries.id, input.entryId))
    .returning();
  if (row)
    void publishFamilyEvent(input.familyId, { kind: 'invalidate', scope: 'meal-plan' });
  return row ?? null;
}

/**
 * Push the entry's ingredients into the family's shopping list as new
 * 'open' items (category 'other'). De-duplication against existing open
 * items is handled by `addItemsBulk` — re-pushing the same meal won't
 * double-up "Молоко" if it's already on the list.
 *
 * Returns the count of added vs skipped so the UI can show
 * "added 5, 2 already on list".
 */
export async function pushToShoppingList(input: {
  familyId: string;
  userId: string;
  entryId: string;
}): Promise<{ added: number; skipped: number } | null> {
  const entry = await db.query.mealPlanEntries.findFirst({
    where: and(eq(mealPlanEntries.id, input.entryId), isNull(mealPlanEntries.deletedAt)),
  });
  if (!entry) return null;
  if (entry.ingredients.length === 0) return { added: 0, skipped: 0 };
  const list = await ensurePrimaryList(entry.familyId);
  const { added, skipped } = await addItemsBulk({
    familyId: entry.familyId,
    listId: list.id,
    userId: input.userId,
    items: entry.ingredients.map((ing) => ({
      text: ing.text,
      quantity: ing.quantity ?? null,
      category: 'other' as const,
    })),
  });
  return { added: added.length, skipped };
}

export function serializeMealPlanEntry(row: MealPlanEntryRow) {
  return {
    id: row.id,
    familyId: row.familyId,
    date: row.date,
    slot: row.slot as MealPlanSlot,
    title: row.title,
    notes: row.notes,
    ingredients: row.ingredients,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
