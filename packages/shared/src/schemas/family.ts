import { z } from 'zod';
import { PERMISSIONS } from '../permissions';

export const familySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(60),
  avatarUrl: z.string().url().nullable(),
  ownerId: z.string().uuid(),
  inviteCode: z.string(),
  inviteCodeExpiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export type Family = z.infer<typeof familySchema>;

export const createFamilySchema = z.object({
  name: z.string().min(1).max(60),
  // Accepts either a URL (when image upload is wired up) or a short string —
  // currently used to hold a family emoji (🏠 🌻 🎈 …).
  avatarUrl: z.string().max(256).nullable().optional(),
});

export type CreateFamilyInput = z.infer<typeof createFamilySchema>;

export const joinFamilySchema = z.object({
  code: z.string().min(4).max(32),
});

export type JoinFamilyInput = z.infer<typeof joinFamilySchema>;

/** Body for `PATCH /api/v1/families/:familyId` (rename / change avatar /
 *  edit pinned note). Empty-string pinnedNote clears the note. */
export const updateFamilySchema = z.object({
  name: z.string().min(1).max(60).optional(),
  avatarUrl: z.string().max(256).nullable().optional(),
  pinnedNote: z.string().max(280).nullable().optional(),
});

export type UpdateFamilyInput = z.infer<typeof updateFamilySchema>;

/** Body for `PATCH /api/v1/families/:familyId/members/:userId/name` — the
 *  family owner sets or clears a member's display name. Null/empty clears
 *  the override (falls back to the Telegram name). */
export const setMemberNameSchema = z.object({
  displayName: z.string().trim().max(60).nullable(),
});

export type SetMemberNameInput = z.infer<typeof setMemberNameSchema>;

export const roleSchema = z.object({
  id: z.string().uuid(),
  familyId: z.string().uuid(),
  name: z.string().min(1).max(40),
  isSystem: z.boolean(),
  permissions: z.array(z.enum(PERMISSIONS)),
  createdAt: z.string().datetime(),
});

export type Role = z.infer<typeof roleSchema>;

export const familyMemberSchema = z.object({
  familyId: z.string().uuid(),
  userId: z.string().uuid(),
  roleId: z.string().uuid(),
  joinedAt: z.string().datetime(),
});

export type FamilyMember = z.infer<typeof familyMemberSchema>;
