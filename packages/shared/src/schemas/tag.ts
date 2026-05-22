import { z } from 'zod';

/**
 * Per-family label that users can attach to tasks. The shape mirrors the
 * `tags` table in the API; the join (task → tags) is surfaced on
 * occurrences/tasks as a `tagIds: string[]` so the client can render
 * chips without a second fetch.
 */
export const tagSchema = z.object({
  id: z.string().uuid(),
  familyId: z.string().uuid(),
  name: z.string().min(1).max(40),
  /** Hex `#rrggbb`. Nullable — UI uses a neutral pill when unset. */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable(),
  createdAt: z.string().datetime(),
});
export type Tag = z.infer<typeof tagSchema>;

export const createTagInputSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
});
export type CreateTagInput = z.infer<typeof createTagInputSchema>;

export const updateTagInputSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
});
export type UpdateTagInput = z.infer<typeof updateTagInputSchema>;
