import { z } from 'zod';

export const FAMILY_EVENT_TYPES = [
  'birthday',
  'anniversary',
  'nameday',
  'memorial',
  'custom',
] as const;
export const familyEventTypeSchema = z.enum(FAMILY_EVENT_TYPES);
export type FamilyEventType = z.infer<typeof familyEventTypeSchema>;

/**
 * Per-event reminder offsets. Each integer is "days before the event"
 * — 0 means day-of, 1 means the day before, 7 means a week ahead.
 * Empty array disables reminders for the event entirely.
 */
const notifyDaysBeforeSchema = z
  .array(z.number().int().min(0).max(365))
  .max(8)
  .default([0, 1, 7]);

export const familyEventSchema = z.object({
  id: z.string().uuid(),
  familyId: z.string().uuid(),
  type: familyEventTypeSchema,
  title: z.string(),
  emoji: z.string().nullable(),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31),
  year: z.number().int().nullable(),
  memberUserId: z.string().uuid().nullable(),
  notifyDaysBefore: z.array(z.number().int()),
  createdByUserId: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type FamilyEvent = z.infer<typeof familyEventSchema>;

export const createFamilyEventInputSchema = z.object({
  type: familyEventTypeSchema.default('custom'),
  title: z.string().trim().min(1).max(100),
  emoji: z.string().trim().max(10).nullable().optional(),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31),
  year: z.number().int().min(1900).max(2200).nullable().optional(),
  memberUserId: z.string().uuid().nullable().optional(),
  notifyDaysBefore: notifyDaysBeforeSchema.optional(),
});
export type CreateFamilyEventInput = z.infer<typeof createFamilyEventInputSchema>;

export const updateFamilyEventInputSchema = z.object({
  type: familyEventTypeSchema.optional(),
  title: z.string().trim().min(1).max(100).optional(),
  emoji: z.string().trim().max(10).nullable().optional(),
  month: z.number().int().min(1).max(12).optional(),
  day: z.number().int().min(1).max(31).optional(),
  year: z.number().int().min(1900).max(2200).nullable().optional(),
  memberUserId: z.string().uuid().nullable().optional(),
  notifyDaysBefore: notifyDaysBeforeSchema.optional(),
});
export type UpdateFamilyEventInput = z.infer<typeof updateFamilyEventInputSchema>;
