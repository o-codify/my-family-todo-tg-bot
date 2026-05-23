import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createTaskCommentInputSchema } from '@family-todo/shared';
import { db } from '../db/client';
import { tasks } from '../db/schema';
import { tgAuth, type AuthVariables } from '../middleware/auth';
import { requireFamily, type FamilyVariables } from '../middleware/family';
import {
  createComment,
  deleteComment,
  listComments,
  serializeTaskComment,
} from '../services/task-comments';

/**
 * Task comments router. Mounted at
 * `/api/v1/families/:familyId/tasks/:taskId/comments` — the parent
 * router supplies `:familyId` via requireFamily and we verify the
 * task lives in that family before any work.
 */
export const taskCommentsRouter = new Hono<{
  Variables: AuthVariables & FamilyVariables;
}>()
  .use('*', tgAuth)
  .use('*', requireFamily);

async function assertTaskInFamily(
  familyId: string,
  taskId: string,
): Promise<boolean> {
  const t = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  return t?.familyId === familyId;
}

taskCommentsRouter.get('/', async (c) => {
  const taskId = c.req.param('taskId');
  if (!taskId) return c.json({ error: 'task_id_required' }, 400);
  if (!(await assertTaskInFamily(c.get('familyId'), taskId))) {
    return c.json({ error: 'task_not_found' }, 404);
  }
  const rows = await listComments({ taskId });
  return c.json({ comments: rows.map(serializeTaskComment) });
});

taskCommentsRouter.post(
  '/',
  zValidator('json', createTaskCommentInputSchema),
  async (c) => {
    const taskId = c.req.param('taskId');
    if (!taskId) return c.json({ error: 'task_id_required' }, 400);
    if (!(await assertTaskInFamily(c.get('familyId'), taskId))) {
      return c.json({ error: 'task_not_found' }, 404);
    }
    const row = await createComment({
      taskId,
      userId: c.get('user').id,
      data: c.req.valid('json'),
    });
    if (!row) return c.json({ error: 'task_not_found' }, 404);
    return c.json({ comment: serializeTaskComment(row) }, 201);
  },
);

taskCommentsRouter.delete('/:commentId', async (c) => {
  const taskId = c.req.param('taskId');
  if (!taskId) return c.json({ error: 'task_id_required' }, 400);
  if (!(await assertTaskInFamily(c.get('familyId'), taskId))) {
    return c.json({ error: 'task_not_found' }, 404);
  }
  const result = await deleteComment({
    commentId: c.req.param('commentId'),
    userId: c.get('user').id,
  });
  if (!result.ok) return c.json({ error: 'comment_not_found_or_not_yours' }, 404);
  return c.body(null, 204);
});
