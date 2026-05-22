import { z } from 'zod';

export const createCatalogItemSchema = z.object({
  name: z.string().min(1).max(100),
  emoji: z.string().max(16).nullable().optional(),
  category: z.string().max(40).nullable().optional(),
  lastPriceCents: z.number().int().nonnegative().nullable().optional(),
  lastCurrency: z.string().max(8).nullable().optional(),
});
export type CreateCatalogItemInput = z.infer<typeof createCatalogItemSchema>;

export const updateCatalogItemSchema = createCatalogItemSchema.partial();
export type UpdateCatalogItemInput = z.infer<typeof updateCatalogItemSchema>;
