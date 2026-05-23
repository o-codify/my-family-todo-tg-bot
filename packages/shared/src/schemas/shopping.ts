import { z } from 'zod';

export const SHOPPING_CATEGORIES = [
  'dairy',
  'produce',
  'meat',
  'bakery',
  'household',
  'drinks',
  'frozen',
  'other',
] as const;
export const shoppingCategorySchema = z.enum(SHOPPING_CATEGORIES);
export type ShoppingCategory = z.infer<typeof shoppingCategorySchema>;

export const shoppingItemStatusSchema = z.enum(['open', 'bought']);
export type ShoppingItemStatus = z.infer<typeof shoppingItemStatusSchema>;

export const shoppingItemSchema = z.object({
  id: z.string().uuid(),
  listId: z.string().uuid(),
  text: z.string(),
  quantity: z.string().nullable(),
  category: shoppingCategorySchema,
  status: shoppingItemStatusSchema,
  assignedUserId: z.string().uuid().nullable(),
  boughtByUserId: z.string().uuid().nullable(),
  boughtAt: z.string().datetime().nullable(),
  createdByUserId: z.string().uuid(),
  position: z.number().int(),
  createdAt: z.string().datetime(),
});
export type ShoppingItem = z.infer<typeof shoppingItemSchema>;

export const createShoppingItemInputSchema = z.object({
  text: z.string().trim().min(1).max(200),
  quantity: z.string().trim().max(40).nullable().optional(),
  category: shoppingCategorySchema.default('other'),
  assignedUserId: z.string().uuid().nullable().optional(),
});
export type CreateShoppingItemInput = z.infer<typeof createShoppingItemInputSchema>;

export const updateShoppingItemInputSchema = z.object({
  text: z.string().trim().min(1).max(200).optional(),
  quantity: z.string().trim().max(40).nullable().optional(),
  category: shoppingCategorySchema.optional(),
  assignedUserId: z.string().uuid().nullable().optional(),
  status: shoppingItemStatusSchema.optional(),
});
export type UpdateShoppingItemInput = z.infer<typeof updateShoppingItemInputSchema>;

export const bulkAddShoppingItemsInputSchema = z.object({
  items: z.array(createShoppingItemInputSchema).min(1).max(100),
});
export type BulkAddShoppingItemsInput = z.infer<typeof bulkAddShoppingItemsInputSchema>;
