import { z } from 'zod';

export const taskCommentSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  userId: z.string().uuid(),
  text: z.string(),
  createdAt: z.string().datetime(),
});
export type TaskComment = z.infer<typeof taskCommentSchema>;

export const createTaskCommentInputSchema = z.object({
  text: z.string().trim().min(1).max(1000),
});
export type CreateTaskCommentInput = z.infer<typeof createTaskCommentInputSchema>;
