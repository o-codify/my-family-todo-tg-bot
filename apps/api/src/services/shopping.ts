import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import type {
  CreateShoppingItemInput,
  ShoppingCategory,
  UpdateShoppingItemInput,
} from '@family-todo/shared';
import { db } from '../db/client';
import {
  catalogItems,
  shoppingItems,
  shoppingLists,
  tasks,
  taskOccurrences,
  type CatalogItemRow,
  type ShoppingItemRow,
  type ShoppingListRow,
} from '../db/schema';
import { publishFamilyEvent } from '../realtime/pubsub';

/**
 * Shopping lists service — multi-list model.
 *
 * Each list is named, has an optional assignee and dueDate, and exists
 * independently (no "primary" list anymore). When dueDate is set we
 * create a one-off backing task so the list shows up on the calendar;
 * dueDate changes reschedule that task, archival clears it.
 *
 * Items can link to a catalog row (`catalog_item_id`). Free-text items
 * auto-create a catalog row on insert (case-insensitive lookup against
 * the per-family unique name index) — over time everything becomes
 * catalog-backed and the picker has fewer duplicates.
 *
 * Most write paths publish a 'shopping' realtime invalidate.
 */

export async function listLists(input: {
  familyId: string;
}): Promise<
  Array<
    ShoppingListRow & {
      openCount: number;
      boughtCount: number;
    }
  >
> {
  const lists = await db
    .select()
    .from(shoppingLists)
    .where(
      and(eq(shoppingLists.familyId, input.familyId), isNull(shoppingLists.archivedAt)),
    )
    .orderBy(desc(shoppingLists.createdAt));
  if (lists.length === 0) return [];

  // One grouped count instead of N queries — keeps the index page snappy
  // even for families with many lists.
  const counts = await db
    .select({
      listId: shoppingItems.listId,
      status: shoppingItems.status,
      cnt: sql<number>`COUNT(*)::int`,
    })
    .from(shoppingItems)
    .where(
      and(
        inArray(
          shoppingItems.listId,
          lists.map((l) => l.id),
        ),
        isNull(shoppingItems.deletedAt),
      ),
    )
    .groupBy(shoppingItems.listId, shoppingItems.status);
  const byList = new Map<string, { open: number; bought: number }>();
  for (const r of counts) {
    const entry = byList.get(r.listId) ?? { open: 0, bought: 0 };
    if (r.status === 'open') entry.open = r.cnt;
    else if (r.status === 'bought') entry.bought = r.cnt;
    byList.set(r.listId, entry);
  }
  return lists.map((l) => {
    const c = byList.get(l.id) ?? { open: 0, bought: 0 };
    return { ...l, openCount: c.open, boughtCount: c.bought };
  });
}

export type ShoppingListWithItems = {
  list: ShoppingListRow;
  items: ShoppingItemRow[];
};

export async function getListWithItems(input: {
  familyId: string;
  listId: string;
}): Promise<ShoppingListWithItems | null> {
  const list = await db.query.shoppingLists.findFirst({
    where: and(
      eq(shoppingLists.id, input.listId),
      eq(shoppingLists.familyId, input.familyId),
    ),
  });
  if (!list) return null;
  const items = await db
    .select()
    .from(shoppingItems)
    .where(and(eq(shoppingItems.listId, list.id), isNull(shoppingItems.deletedAt)))
    .orderBy(
      asc(shoppingItems.status),
      asc(shoppingItems.position),
      desc(shoppingItems.createdAt),
    );
  return { list, items };
}

export async function createList(input: {
  familyId: string;
  userId: string;
  data: {
    name: string;
    assigneeUserId?: string | null;
    dueDate?: string | null;
  };
}): Promise<ShoppingListRow> {
  const [list] = await db
    .insert(shoppingLists)
    .values({
      familyId: input.familyId,
      name: input.data.name.trim(),
      assigneeUserId: input.data.assigneeUserId ?? null,
      dueDate: input.data.dueDate ?? null,
      createdByUserId: input.userId,
    })
    .returning();
  // dueDate → backing task on the calendar. Created in a follow-up
  // step so a backing-task failure doesn't roll back the list insert.
  // We re-fetch so the returned row carries the freshly-stamped taskId.
  if (list && input.data.dueDate) {
    await ensureBackingTask({
      familyId: input.familyId,
      userId: input.userId,
      list,
    });
  }
  const final = list
    ? await db.query.shoppingLists.findFirst({
        where: eq(shoppingLists.id, list.id),
      })
    : undefined;
  void publishFamilyEvent(input.familyId, { kind: 'invalidate', scope: 'shopping' });
  void publishFamilyEvent(input.familyId, { kind: 'invalidate', scope: 'tasks' });
  return final ?? list!;
}

export async function updateList(input: {
  familyId: string;
  listId: string;
  userId: string;
  patch: {
    name?: string;
    assigneeUserId?: string | null;
    dueDate?: string | null;
  };
}): Promise<ShoppingListRow | null> {
  const existing = await db.query.shoppingLists.findFirst({
    where: and(
      eq(shoppingLists.id, input.listId),
      eq(shoppingLists.familyId, input.familyId),
    ),
  });
  if (!existing) return null;
  const next: Partial<typeof shoppingLists.$inferInsert> = {};
  if (input.patch.name !== undefined) next.name = input.patch.name.trim();
  if (input.patch.assigneeUserId !== undefined) {
    next.assigneeUserId = input.patch.assigneeUserId;
  }
  if (input.patch.dueDate !== undefined) next.dueDate = input.patch.dueDate;
  if (Object.keys(next).length === 0) return existing;
  next.updatedAt = new Date();
  const [row] = await db
    .update(shoppingLists)
    .set(next)
    .where(eq(shoppingLists.id, input.listId))
    .returning();
  if (!row) return null;
  // Re-sync the backing task. Four cases:
  //   was-dated → dated-different    → reschedule
  //   was-dated → dateless          → drop the task
  //   was-dateless → dated          → create task
  //   was-dated, assignee changed   → update assignee on task
  const taskNeedsRefresh =
    input.patch.dueDate !== undefined || input.patch.assigneeUserId !== undefined ||
    input.patch.name !== undefined;
  if (taskNeedsRefresh) {
    if (row.dueDate) {
      await ensureBackingTask({
        familyId: input.familyId,
        userId: input.userId,
        list: row,
      });
    } else if (row.taskId) {
      await dropBackingTask({
        familyId: input.familyId,
        list: row,
      });
    }
  }
  // Re-fetch so the returned row carries the latest taskId (created or
  // cleared by the ensure/drop calls above).
  const final = await db.query.shoppingLists.findFirst({
    where: eq(shoppingLists.id, row.id),
  });
  void publishFamilyEvent(input.familyId, { kind: 'invalidate', scope: 'shopping' });
  void publishFamilyEvent(input.familyId, { kind: 'invalidate', scope: 'tasks' });
  return final ?? row;
}

export async function archiveList(input: {
  familyId: string;
  listId: string;
}): Promise<boolean> {
  const list = await db.query.shoppingLists.findFirst({
    where: and(
      eq(shoppingLists.id, input.listId),
      eq(shoppingLists.familyId, input.familyId),
    ),
  });
  if (!list || list.archivedAt) return false;
  await db
    .update(shoppingLists)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(shoppingLists.id, input.listId));
  if (list.taskId) {
    await dropBackingTask({ familyId: input.familyId, list });
  }
  void publishFamilyEvent(input.familyId, { kind: 'invalidate', scope: 'shopping' });
  void publishFamilyEvent(input.familyId, { kind: 'invalidate', scope: 'tasks' });
  return true;
}

export async function restoreList(input: {
  familyId: string;
  listId: string;
}): Promise<ShoppingListRow | null> {
  const [row] = await db
    .update(shoppingLists)
    .set({ archivedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(shoppingLists.id, input.listId),
        eq(shoppingLists.familyId, input.familyId),
      ),
    )
    .returning();
  if (row) {
    void publishFamilyEvent(input.familyId, { kind: 'invalidate', scope: 'shopping' });
  }
  return row ?? null;
}

/**
 * Create or update the one-off backing task for a list with dueDate.
 * Idempotent — call freely from update paths.
 */
async function ensureBackingTask(input: {
  familyId: string;
  userId: string;
  list: ShoppingListRow;
}): Promise<void> {
  if (!input.list.dueDate) return;
  const title = `🛒 ${input.list.name}`;

  if (input.list.taskId) {
    // Update existing task title + reschedule occurrence.
    await db
      .update(tasks)
      .set({
        title,
        assigneeId: input.list.assigneeUserId,
        schedule: {
          kind: 'oneoff',
          date: input.list.dueDate,
        },
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, input.list.taskId));
    // Move any pending occurrence to the new date. The task generator
    // logic would normally do this on save, but we're bypassing
    // updateTask so we touch occurrences directly.
    await db
      .update(taskOccurrences)
      .set({
        scheduledDate: input.list.dueDate,
        assigneeId: input.list.assigneeUserId,
      })
      .where(
        and(
          eq(taskOccurrences.taskId, input.list.taskId),
          eq(taskOccurrences.status, 'pending'),
        ),
      );
    return;
  }

  // First time we're stamping a dueDate — create the task + occurrence.
  const [task] = await db
    .insert(tasks)
    .values({
      familyId: input.familyId,
      title,
      description: null,
      type: 'oneoff',
      schedule: { kind: 'oneoff', date: input.list.dueDate },
      assigneeId: input.list.assigneeUserId,
      points: 0,
      photoRequired: false,
      requiresApproval: false,
      isQuest: false,
      singleShot: false,
      createdBy: input.userId,
    })
    .returning();
  if (!task) return;
  await db.insert(taskOccurrences).values({
    taskId: task.id,
    scheduledDate: input.list.dueDate,
    assigneeId: input.list.assigneeUserId,
    status: 'pending',
  });
  await db
    .update(shoppingLists)
    .set({ taskId: task.id })
    .where(eq(shoppingLists.id, input.list.id));
}

/** Tear down the backing task when a list goes dateless or archived. */
async function dropBackingTask(input: {
  familyId: string;
  list: ShoppingListRow;
}): Promise<void> {
  if (!input.list.taskId) return;
  // Archive the task rather than delete — keeps history coherent if
  // someone later looks at it. The associated pending occurrence is
  // dropped so it doesn't litter the calendar.
  await db
    .delete(taskOccurrences)
    .where(
      and(
        eq(taskOccurrences.taskId, input.list.taskId),
        eq(taskOccurrences.status, 'pending'),
      ),
    );
  await db
    .update(tasks)
    .set({ archivedAt: new Date() })
    .where(eq(tasks.id, input.list.taskId));
  await db
    .update(shoppingLists)
    .set({ taskId: null })
    .where(eq(shoppingLists.id, input.list.id));
  void input.familyId;
}

// ─── items ──────────────────────────────────────────────────────────

async function ensureCatalogEntry(input: {
  familyId: string;
  userId: string;
  name: string;
  category?: string | null;
}): Promise<CatalogItemRow> {
  // Case-insensitive lookup — matches the family's unique index.
  const existing = await db.query.catalogItems.findFirst({
    where: and(
      eq(catalogItems.familyId, input.familyId),
      sql`lower(${catalogItems.name}) = lower(${input.name.trim()})`,
    ),
  });
  if (existing) return existing;
  const [row] = await db
    .insert(catalogItems)
    .values({
      familyId: input.familyId,
      name: input.name.trim(),
      category: input.category ?? null,
      createdBy: input.userId,
    })
    .returning();
  return row!;
}

export async function addItem(input: {
  familyId: string;
  listId: string;
  userId: string;
  data: CreateShoppingItemInput & { catalogItemId?: string | null };
}): Promise<ShoppingItemRow> {
  const list = await db.query.shoppingLists.findFirst({
    where: and(
      eq(shoppingLists.id, input.listId),
      eq(shoppingLists.familyId, input.familyId),
    ),
  });
  if (!list) throw new Error('list_not_found');

  // Per user decision: every free-text item auto-promotes to a catalog
  // row so duplicates trend down over time.
  let catalogItemId = input.data.catalogItemId ?? null;
  if (!catalogItemId) {
    const cat = await ensureCatalogEntry({
      familyId: input.familyId,
      userId: input.userId,
      name: input.data.text,
      category: input.data.category,
    });
    catalogItemId = cat.id;
  }

  const [maxRow] = await db
    .select({ max: sql<number>`COALESCE(MAX(${shoppingItems.position}), 0)::int` })
    .from(shoppingItems)
    .where(eq(shoppingItems.listId, input.listId));
  const nextPosition = (maxRow?.max ?? 0) + 1;
  const [row] = await db
    .insert(shoppingItems)
    .values({
      listId: input.listId,
      catalogItemId,
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

/** Bulk-add catalog rows into a list as new shopping items. The picker
 *  modal hands us an array of catalog ids — we look them up, dedupe
 *  against existing OPEN items on the list, and insert the rest. */
export async function addCatalogItemsToList(input: {
  familyId: string;
  listId: string;
  userId: string;
  catalogItemIds: string[];
}): Promise<{ added: ShoppingItemRow[]; skipped: number }> {
  if (input.catalogItemIds.length === 0) return { added: [], skipped: 0 };
  const list = await db.query.shoppingLists.findFirst({
    where: and(
      eq(shoppingLists.id, input.listId),
      eq(shoppingLists.familyId, input.familyId),
    ),
  });
  if (!list) throw new Error('list_not_found');
  const cats = await db
    .select()
    .from(catalogItems)
    .where(
      and(
        eq(catalogItems.familyId, input.familyId),
        inArray(catalogItems.id, input.catalogItemIds),
      ),
    );

  const existing = await db
    .select({ catalogItemId: shoppingItems.catalogItemId, text: shoppingItems.text })
    .from(shoppingItems)
    .where(
      and(
        eq(shoppingItems.listId, input.listId),
        eq(shoppingItems.status, 'open'),
        isNull(shoppingItems.deletedAt),
      ),
    );
  const haveCat = new Set(
    existing.map((r) => r.catalogItemId).filter((id): id is string => id !== null),
  );
  const haveText = new Set(existing.map((r) => r.text.trim().toLowerCase()));

  const toInsert = cats.filter(
    (c) => !haveCat.has(c.id) && !haveText.has(c.name.trim().toLowerCase()),
  );
  const skipped = cats.length - toInsert.length;
  if (toInsert.length === 0) return { added: [], skipped };

  const [maxRow] = await db
    .select({ max: sql<number>`COALESCE(MAX(${shoppingItems.position}), 0)::int` })
    .from(shoppingItems)
    .where(eq(shoppingItems.listId, input.listId));
  let pos = (maxRow?.max ?? 0) + 1;

  const inserted = await db
    .insert(shoppingItems)
    .values(
      toInsert.map((c) => ({
        listId: input.listId,
        catalogItemId: c.id,
        text: c.name,
        quantity: null,
        category: (c.category as ShoppingCategory | null) ?? 'other',
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
    if (input.patch.status === 'bought') {
      next.boughtByUserId = input.userId;
      next.boughtAt = new Date();
    } else {
      next.boughtByUserId = null;
      next.boughtAt = null;
    }
  }
  if (Object.keys(next).length === 0) {
    return db.query.shoppingItems.findFirst({
      where: eq(shoppingItems.id, input.itemId),
    }) as Promise<ShoppingItemRow | null>;
  }
  const [row] = await db
    .update(shoppingItems)
    .set(next)
    .where(eq(shoppingItems.id, input.itemId))
    .returning();
  if (row)
    void publishFamilyEvent(input.familyId, { kind: 'invalidate', scope: 'shopping' });
  return row ?? null;
}

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
  if (row)
    void publishFamilyEvent(input.familyId, { kind: 'invalidate', scope: 'shopping' });
  return row ?? null;
}

/** Move an item from its current list to another. Position is recomputed
 *  to be max+1 on the destination so it lands at the end. */
export async function moveItem(input: {
  familyId: string;
  itemId: string;
  targetListId: string;
}): Promise<ShoppingItemRow | null> {
  const item = await db.query.shoppingItems.findFirst({
    where: eq(shoppingItems.id, input.itemId),
  });
  if (!item) return null;
  // Target list must belong to the same family — auth boundary.
  const target = await db.query.shoppingLists.findFirst({
    where: and(
      eq(shoppingLists.id, input.targetListId),
      eq(shoppingLists.familyId, input.familyId),
    ),
  });
  if (!target) return null;

  const [maxRow] = await db
    .select({ max: sql<number>`COALESCE(MAX(${shoppingItems.position}), 0)::int` })
    .from(shoppingItems)
    .where(eq(shoppingItems.listId, input.targetListId));
  const nextPosition = (maxRow?.max ?? 0) + 1;

  const [row] = await db
    .update(shoppingItems)
    .set({ listId: input.targetListId, position: nextPosition })
    .where(eq(shoppingItems.id, input.itemId))
    .returning();
  if (row)
    void publishFamilyEvent(input.familyId, { kind: 'invalidate', scope: 'shopping' });
  return row ?? null;
}

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

// ─── serializers ────────────────────────────────────────────────────

export function serializeShoppingItem(row: ShoppingItemRow) {
  return {
    id: row.id,
    listId: row.listId,
    catalogItemId: row.catalogItemId,
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

export function serializeShoppingList(
  row: ShoppingListRow & { openCount?: number; boughtCount?: number },
) {
  return {
    id: row.id,
    familyId: row.familyId,
    name: row.name,
    assigneeUserId: row.assigneeUserId,
    dueDate: row.dueDate,
    taskId: row.taskId,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    openCount: row.openCount,
    boughtCount: row.boughtCount,
  };
}

// Range query helper used elsewhere — silence unused-import warning.
void gte;
void lte;
