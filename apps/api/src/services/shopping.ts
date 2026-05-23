import { and, asc, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type {
  CreateShoppingItemInput,
  ShoppingCategory,
  UpdateShoppingItemInput,
} from '@family-todo/shared';
import { db } from '../db/client';
import {
  shoppingItems,
  shoppingLists,
  type ShoppingItemRow,
  type ShoppingListRow,
} from '../db/schema';
import { publishFamilyEvent } from '../realtime/pubsub';

/**
 * Shopping list service.
 *
 * One "primary" list per family, auto-created on first read. Items have
 * status open/bought; bought items stay visible (the buyer wants their
 * receipt) until an explicit archive sweeps them. Soft delete via
 * `deletedAt` mirrors the tasks pattern so an "Удалено · Отменить"
 * toast can restore the row.
 */

export async function ensurePrimaryList(familyId: string): Promise<ShoppingListRow> {
  // Pick an existing primary, OR resurrect the most-recently-created list
  // and flag it primary, OR create one. Lazy seeding keeps families that
  // never use shopping free of stub rows.
  const existing = await db.query.shoppingLists.findFirst({
    where: and(
      eq(shoppingLists.familyId, familyId),
      eq(shoppingLists.isPrimary, 'true'),
      isNull(shoppingLists.archivedAt),
    ),
  });
  if (existing) return existing;
  const [created] = await db
    .insert(shoppingLists)
    .values({
      familyId,
      name: 'Shopping',
      isPrimary: 'true',
    })
    .returning();
  return created!;
}

export type ShoppingListWithItems = {
  list: ShoppingListRow;
  items: ShoppingItemRow[];
};

export async function getPrimaryListWithItems(
  familyId: string,
): Promise<ShoppingListWithItems> {
  const list = await ensurePrimaryList(familyId);
  const items = await db
    .select()
    .from(shoppingItems)
    .where(and(eq(shoppingItems.listId, list.id), isNull(shoppingItems.deletedAt)))
    .orderBy(
      asc(shoppingItems.status), // 'bought' > 'open' alphabetically → opens first
      asc(shoppingItems.position),
      desc(shoppingItems.createdAt),
    );
  return { list, items };
}

export async function addItem(input: {
  familyId: string;
  listId: string;
  userId: string;
  data: CreateShoppingItemInput;
}): Promise<ShoppingItemRow> {
  // Position = max(position) + 1 inside the list so new items append. Cheap
  // because we never expect a list larger than a few hundred items.
  const [maxRow] = await db
    .select({ max: sql<number>`COALESCE(MAX(${shoppingItems.position}), 0)::int` })
    .from(shoppingItems)
    .where(eq(shoppingItems.listId, input.listId));
  const nextPosition = (maxRow?.max ?? 0) + 1;
  const [row] = await db
    .insert(shoppingItems)
    .values({
      listId: input.listId,
      text: input.data.text,
      quantity: input.data.quantity ?? null,
      category: input.data.category,
      assignedUserId: input.data.assignedUserId ?? null,
      createdByUserId: input.userId,
      position: nextPosition,
    })
    .returning();
  void publishFamilyEvent(input.familyId, { kind: 'invalidate', scope: 'shopping' });
  return row!;
}

/** Bulk insert — used by meal-plan → shopping (Phase C) and any future
 *  "add from catalog" flow. Skips items whose text already matches an
 *  OPEN entry on the same list (case-insensitive) so a meal-plan re-export
 *  doesn't duplicate "Молоко". `bought` rows don't block — they're treated
 *  as a separate purchase. */
export async function addItemsBulk(input: {
  familyId: string;
  listId: string;
  userId: string;
  items: CreateShoppingItemInput[];
}): Promise<{ added: ShoppingItemRow[]; skipped: number }> {
  const existing = await db
    .select({ text: shoppingItems.text })
    .from(shoppingItems)
    .where(
      and(
        eq(shoppingItems.listId, input.listId),
        eq(shoppingItems.status, 'open'),
        isNull(shoppingItems.deletedAt),
      ),
    );
  const have = new Set(existing.map((r) => r.text.trim().toLowerCase()));

  const toInsert = input.items.filter(
    (it) => !have.has(it.text.trim().toLowerCase()),
  );
  const skipped = input.items.length - toInsert.length;
  if (toInsert.length === 0) return { added: [], skipped };

  const [maxRow] = await db
    .select({ max: sql<number>`COALESCE(MAX(${shoppingItems.position}), 0)::int` })
    .from(shoppingItems)
    .where(eq(shoppingItems.listId, input.listId));
  let pos = (maxRow?.max ?? 0) + 1;

  const inserted = await db
    .insert(shoppingItems)
    .values(
      toInsert.map((it) => ({
        listId: input.listId,
        text: it.text,
        quantity: it.quantity ?? null,
        category: (it.category ?? 'other') as ShoppingCategory,
        assignedUserId: it.assignedUserId ?? null,
        createdByUserId: input.userId,
        position: pos++,
      })),
    )
    .returning();
  void publishFamilyEvent(input.familyId, { kind: 'invalidate', scope: 'shopping' });
  return { added: inserted, skipped };
}

export async function updateItem(input: {
  familyId: string;
  itemId: string;
  userId: string;
  patch: UpdateShoppingItemInput;
}): Promise<ShoppingItemRow | null> {
  const next: Partial<typeof shoppingItems.$inferInsert> = {};
  if (input.patch.text !== undefined) next.text = input.patch.text;
  if (input.patch.quantity !== undefined) next.quantity = input.patch.quantity;
  if (input.patch.category !== undefined) next.category = input.patch.category;
  if (input.patch.assignedUserId !== undefined) {
    next.assignedUserId = input.patch.assignedUserId;
  }
  if (input.patch.status !== undefined) {
    next.status = input.patch.status;
    // Stamp buyer + time when flipping to bought; clear them on un-buy.
    if (input.patch.status === 'bought') {
      next.boughtByUserId = input.userId;
      next.boughtAt = new Date();
    } else {
      next.boughtByUserId = null;
      next.boughtAt = null;
    }
  }
  if (Object.keys(next).length === 0) {
    const existing = await db.query.shoppingItems.findFirst({
      where: eq(shoppingItems.id, input.itemId),
    });
    return existing ?? null;
  }
  const [row] = await db
    .update(shoppingItems)
    .set(next)
    .where(eq(shoppingItems.id, input.itemId))
    .returning();
  if (row) void publishFamilyEvent(input.familyId, { kind: 'invalidate', scope: 'shopping' });
  return row ?? null;
}

/** Soft delete — sets deletedAt so the UI can show "Undo". Restore by
 *  PATCHing back to deletedAt=null via `restoreItem`. */
export async function deleteItem(input: {
  familyId: string;
  itemId: string;
}): Promise<boolean> {
  const res = await db
    .update(shoppingItems)
    .set({ deletedAt: new Date() })
    .where(and(eq(shoppingItems.id, input.itemId), isNull(shoppingItems.deletedAt)))
    .returning({ id: shoppingItems.id });
  if (res.length > 0) {
    void publishFamilyEvent(input.familyId, { kind: 'invalidate', scope: 'shopping' });
  }
  return res.length > 0;
}

export async function restoreItem(input: {
  familyId: string;
  itemId: string;
}): Promise<ShoppingItemRow | null> {
  const [row] = await db
    .update(shoppingItems)
    .set({ deletedAt: null })
    .where(eq(shoppingItems.id, input.itemId))
    .returning();
  if (row) void publishFamilyEvent(input.familyId, { kind: 'invalidate', scope: 'shopping' });
  return row ?? null;
}

/** Sweep bought items older than `days` into soft-deleted state. Called
 *  by the user via an "Archive bought" button — not a cron. */
export async function archiveBought(input: {
  familyId: string;
  listId: string;
  olderThanDays?: number;
}): Promise<number> {
  const days = input.olderThanDays ?? 0;
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const res = await db
    .update(shoppingItems)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(shoppingItems.listId, input.listId),
        eq(shoppingItems.status, 'bought'),
        lt(shoppingItems.boughtAt, cutoff),
        isNull(shoppingItems.deletedAt),
      ),
    )
    .returning({ id: shoppingItems.id });
  if (res.length > 0) {
    void publishFamilyEvent(input.familyId, { kind: 'invalidate', scope: 'shopping' });
  }
  return res.length;
}

export function serializeShoppingItem(row: ShoppingItemRow) {
  return {
    id: row.id,
    listId: row.listId,
    text: row.text,
    quantity: row.quantity,
    category: row.category as ShoppingCategory,
    status: row.status as 'open' | 'bought',
    assignedUserId: row.assignedUserId,
    boughtByUserId: row.boughtByUserId,
    boughtAt: row.boughtAt?.toISOString() ?? null,
    createdByUserId: row.createdByUserId,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
  };
}

export function serializeShoppingList(row: ShoppingListRow) {
  return {
    id: row.id,
    familyId: row.familyId,
    name: row.name,
    isPrimary: row.isPrimary === 'true',
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
