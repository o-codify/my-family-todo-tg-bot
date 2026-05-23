import { z } from 'zod';

export const MEAL_PLAN_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack', 'other'] as const;
export const mealPlanSlotSchema = z.enum(MEAL_PLAN_SLOTS);
export type MealPlanSlot = z.infer<typeof mealPlanSlotSchema>;

export const mealIngredientSchema = z.object({
  text: z.string().trim().min(1).max(120),
  quantity: z.string().trim().max(40).nullable().optional(),
});
export type MealIngredient = z.infer<typeof mealIngredientSchema>;

export const mealPlanEntrySchema = z.object({
  id: z.string().uuid(),
  familyId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slot: mealPlanSlotSchema,
  title: z.string(),
  notes: z.string().nullable(),
  ingredients: z.array(mealIngredientSchema),
  createdByUserId: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type MealPlanEntry = z.infer<typeof mealPlanEntrySchema>;

export const createMealPlanEntryInputSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slot: mealPlanSlotSchema.default('dinner'),
  title: z.string().trim().min(1).max(120),
  notes: z.string().trim().max(2000).nullable().optional(),
  ingredients: z.array(mealIngredientSchema).max(50).optional(),
});
export type CreateMealPlanEntryInput = z.infer<typeof createMealPlanEntryInputSchema>;

export const updateMealPlanEntryInputSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  slot: mealPlanSlotSchema.optional(),
  title: z.string().trim().min(1).max(120).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  ingredients: z.array(mealIngredientSchema).max(50).optional(),
});
export type UpdateMealPlanEntryInput = z.infer<typeof updateMealPlanEntryInputSchema>;
