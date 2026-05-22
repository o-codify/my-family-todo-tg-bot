import { and, asc, desc, eq, ilike, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { catalogItems, type CatalogItemRow } from '../db/schema';

export type CreateCatalogItem = {
  name: string;
  emoji?: string | null;
  category?: string | null;
  lastPriceCents?: number | null;
  lastCurrency?: string | null;
};

export async function listCatalog(
  familyId: string,
  query?: string,
): Promise<CatalogItemRow[]> {
  const conditions = [eq(catalogItems.familyId, familyId)];
  if (query && query.trim()) {
    conditions.push(ilike(catalogItems.name, `%${query.trim()}%`));
  }
  return db
    .select()
    .from(catalogItems)
    .where(and(...conditions))
    .orderBy(desc(catalogItems.usageCount), asc(catalogItems.name));
}

export async function createCatalogItem(input: {
  familyId: string;
  createdBy: string;
  data: CreateCatalogItem;
}): Promise<CatalogItemRow> {
  const [row] = await db
    .insert(catalogItems)
    .values({
      familyId: input.familyId,
      createdBy: input.createdBy,
      name: input.data.name.trim(),
      emoji: input.data.emoji ?? null,
      category: input.data.category ?? null,
      lastPriceCents: input.data.lastPriceCents ?? null,
      lastCurrency: input.data.lastCurrency ?? null,
    })
    .returning();
  return row!;
}

export async function updateCatalogItem(input: {
  itemId: string;
  familyId: string;
  data: Partial<CreateCatalogItem>;
}): Promise<CatalogItemRow | null> {
  const next: Partial<typeof catalogItems.$inferInsert> = { updatedAt: new Date() };
  if (input.data.name !== undefined) next.name = input.data.name.trim();
  if (input.data.emoji !== undefined) next.emoji = input.data.emoji ?? null;
  if (input.data.category !== undefined) next.category = input.data.category ?? null;
  if (input.data.lastPriceCents !== undefined)
    next.lastPriceCents = input.data.lastPriceCents ?? null;
  if (input.data.lastCurrency !== undefined)
    next.lastCurrency = input.data.lastCurrency ?? null;
  const [updated] = await db
    .update(catalogItems)
    .set(next)
    .where(and(eq(catalogItems.id, input.itemId), eq(catalogItems.familyId, input.familyId)))
    .returning();
  return updated ?? null;
}

export async function deleteCatalogItem(input: {
  itemId: string;
  familyId: string;
}): Promise<boolean> {
  const result = await db
    .delete(catalogItems)
    .where(and(eq(catalogItems.id, input.itemId), eq(catalogItems.familyId, input.familyId)))
    .returning({ id: catalogItems.id });
  return result.length > 0;
}

export async function bumpCatalogUsage(itemId: string): Promise<void> {
  await db
    .update(catalogItems)
    .set({
      usageCount: sql`${catalogItems.usageCount} + 1`,
      lastUsedAt: new Date(),
    })
    .where(eq(catalogItems.id, itemId));
}

export function serializeCatalogItem(row: CatalogItemRow) {
  return {
    id: row.id,
    familyId: row.familyId,
    name: row.name,
    emoji: row.emoji,
    category: row.category,
    lastPriceCents: row.lastPriceCents,
    lastCurrency: row.lastCurrency,
    usageCount: row.usageCount,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
