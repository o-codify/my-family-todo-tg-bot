import { z } from 'zod';

export const notificationSettingsSchema = z.object({
  quietHoursStart: z.string().regex(/^\d{2}:\d{2}$/).nullable().default(null),
  quietHoursEnd: z.string().regex(/^\d{2}:\d{2}$/).nullable().default(null),
  digestEnabled: z.boolean().default(true),
  digestTime: z.string().regex(/^\d{2}:\d{2}$/).default('08:00'),
  defaultReminderBeforeMinutes: z.number().int().min(0).max(1440).default(15),
});

export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

// Per-user client preferences. Schema-less bag — the backend round-trips it
// without inspecting individual keys, so adding a new preference is just a
// frontend change. Keep entries additive: never reshape an existing key.
export const userPreferencesSchema = z.record(z.unknown());

export type UserPreferences = z.infer<typeof userPreferencesSchema>;

export const userSchema = z.object({
  id: z.string().uuid(),
  telegramId: z.string(),
  username: z.string().nullable(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  avatarUrl: z.string().url().nullable(),
  locale: z.string(),
  timezone: z.string(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  notificationSettings: notificationSettingsSchema,
  awayUntil: z.string().datetime().nullable(),
  awayReason: z.enum(['vacation', 'sick']).nullable(),
  preferences: userPreferencesSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type User = z.infer<typeof userSchema>;

export const updateMeSchema = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  locale: z.string().optional(),
  timezone: z.string().optional(),
  notificationSettings: notificationSettingsSchema.partial().optional(),
  awayUntil: z.string().datetime().nullable().optional(),
  awayReason: z.enum(['vacation', 'sick']).nullable().optional(),
  // Partial preferences merge with the existing record server-side. Pass
  // `{ preferences: { foo: null } }` to clear a single key; or pass a fresh
  // object to overwrite the whole record (rarely useful).
  preferences: userPreferencesSchema.optional(),
});

export type UpdateMeInput = z.infer<typeof updateMeSchema>;
