import { z } from 'zod';

export const PERMISSION_REQUEST_TYPES = [
  'screen_time',
  'friend_visit',
  'spending',
  'food',
  'other',
] as const;
export const permissionRequestTypeSchema = z.enum(PERMISSION_REQUEST_TYPES);
export type PermissionRequestType = z.infer<typeof permissionRequestTypeSchema>;

export const PERMISSION_REQUEST_STATUSES = [
  'pending',
  'approved',
  'denied',
  'cancelled',
] as const;
export const permissionRequestStatusSchema = z.enum(PERMISSION_REQUEST_STATUSES);
export type PermissionRequestStatus = z.infer<typeof permissionRequestStatusSchema>;

export const permissionRequestSchema = z.object({
  id: z.string().uuid(),
  familyId: z.string().uuid(),
  requesterUserId: z.string().uuid(),
  type: permissionRequestTypeSchema,
  text: z.string(),
  status: permissionRequestStatusSchema,
  decidedByUserId: z.string().uuid().nullable(),
  decidedAt: z.string().datetime().nullable(),
  decisionReason: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type PermissionRequest = z.infer<typeof permissionRequestSchema>;

export const createPermissionRequestInputSchema = z.object({
  type: permissionRequestTypeSchema.default('other'),
  text: z.string().trim().min(1).max(280),
});
export type CreatePermissionRequestInput = z.infer<
  typeof createPermissionRequestInputSchema
>;

export const decidePermissionRequestInputSchema = z.object({
  /** 'approved' or 'denied' — terminal decision. */
  decision: z.enum(['approved', 'denied']),
  reason: z.string().trim().max(280).nullable().optional(),
});
export type DecidePermissionRequestInput = z.infer<
  typeof decidePermissionRequestInputSchema
>;
