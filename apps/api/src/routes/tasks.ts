import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import {
  completeOccurrenceSchema,
  createTaskSchema,
  updateTaskSchema,
  type Permission,
} from '@family-todo/shared';
import { tgAuth, type AuthVariables } from '../middleware/auth';
import { requireFamily, requirePermission, type FamilyVariables } from '../middleware/family';
import {
  completeFloatingTask,
  OccurrenceActionError,
  serializeOccurrence,
} from '../services/occurrence-actions';
import {
  archiveTask,
  createTask,
  getTaskInFamily,
  listFamilyTasks,
  restoreTask,
  serializeTask,
  updateTask,
} from '../services/tasks';
import { getTagIdsForTasks } from '../services/tags';

export const tasksRouter = new Hono<{ Variables: AuthVariables & FamilyVariables }>()
  .use('*', tgAuth)
  .use('*', requireFamily);

tasksRouter.get('/', async (c) => {
  const familyId = c.get('familyId');
  const tasks = await listFamilyTasks(familyId);
  // Batch-lookup tag attachments so we don't run N+1 queries while
  // serializing. Tasks without any tags just get an empty array.
  const tagMap = await getTagIdsForTasks(tasks.map((t) => t.id));
  return c.json({ tasks: tasks.map((t) => serializeTask(t, tagMap.get(t.id) ?? [])) });
});

tasksRouter.post(
  '/',
  requirePermission('task.create'),
  zValidator('json', createTaskSchema),
  async (c) => {
    const user = c.get('user');
    const familyId = c.get('familyId');
    const data = c.req.valid('json');
    const task = await createTask({ familyId, createdBy: user.id, data });
    const tagMap = await getTagIdsForTasks([task.id]);
    return c.json({ task: serializeTask(task, tagMap.get(task.id) ?? []) }, 201);
  },
);

tasksRouter.get('/:taskId', async (c) => {
  const familyId = c.get('familyId');
  const task = await getTaskInFamily(c.req.param('taskId'), familyId);
  if (!task) return c.json({ error: 'task_not_found' }, 404);
  const tagMap = await getTagIdsForTasks([task.id]);
  return c.json({ task: serializeTask(task, tagMap.get(task.id) ?? []) });
});

tasksRouter.patch(
  '/:taskId',
  zValidator('json', updateTaskSchema),
  requirePermission(({ var: v }): Permission | null => {
    // permission is decided after we load the task; fallback check below
    return null;
  }),
  async (c) => {
    const user = c.get('user');
    const familyId = c.get('familyId');
    const task = await getTaskInFamily(c.req.param('taskId'), familyId);
    if (!task) return c.json({ error: 'task_not_found' }, 404);

    const isOwn = task.createdBy === user.id;
    const needed: Permission = isOwn ? 'task.edit.own' : 'task.edit.any';
    if (!c.get('permissions').includes(needed)) {
      return c.json({ error: 'forbidden', permission: needed }, 403);
    }

    const updated = await updateTask({ task, data: c.req.valid('json') });
    const tagMap = await getTagIdsForTasks([updated.id]);
    return c.json({ task: serializeTask(updated, tagMap.get(updated.id) ?? []) });
  },
);

tasksRouter.post(
  '/:taskId/complete-floating',
  zValidator('json', completeOccurrenceSchema),
  async (c) => {
    const user = c.get('user');
    const familyId = c.get('familyId');
    const task = await getTaskInFamily(c.req.param('taskId'), familyId);
    if (!task) return c.json({ error: 'task_not_found' }, 404);
    if (task.type !== 'floating') return c.json({ error: 'wrong_task_type' }, 400);

    try {
      const occurrence = await completeFloatingTask({
        task,
        userId: user.id,
        data: c.req.valid('json'),
      });
      return c.json({ occurrence: serializeOccurrence({ ...occurrence, task }) });
    } catch (err) {
      if (err instanceof OccurrenceActionError) return c.json({ error: err.code }, 400);
      throw err;
    }
  },
);

tasksRouter.delete('/:taskId', async (c) => {
  const user = c.get('user');
  const familyId = c.get('familyId');
  const task = await getTaskInFamily(c.req.param('taskId'), familyId);
  if (!task) return c.json({ error: 'task_not_found' }, 404);

  const isOwn = task.createdBy === user.id;
  const needed: Permission = isOwn ? 'task.delete.own' : 'task.delete.any';
  if (!c.get('permissions').includes(needed)) {
    return c.json({ error: 'forbidden', permission: needed }, 403);
  }

  await archiveTask(task.id);
  return c.body(null, 204);
});

/**
 * Undo for `DELETE /tasks/:taskId`. The miniapp shows a 5-second toast
 * "Удалено · Отменить" after deletion — tapping it POSTs here. Permission:
 * same as delete (caller must be allowed to manage this task in the first
 * place).
 */
tasksRouter.post('/:taskId/restore', async (c) => {
  const user = c.get('user');
  const familyId = c.get('familyId');
  // Note: getTaskInFamily includes archived rows since it doesn't filter
  // by archivedAt — that's exactly what we need for restore.
  const task = await getTaskInFamily(c.req.param('taskId'), familyId);
  if (!task) return c.json({ error: 'task_not_found' }, 404);

  const isOwn = task.createdBy === user.id;
  const needed: Permission = isOwn ? 'task.delete.own' : 'task.delete.any';
  if (!c.get('permissions').includes(needed)) {
    return c.json({ error: 'forbidden', permission: needed }, 403);
  }

  const restored = await restoreTask(task.id);
  if (!restored) return c.json({ error: 'task_not_found' }, 404);
  const tagMap = await getTagIdsForTasks([restored.id]);
  return c.json({ task: serializeTask(restored, tagMap.get(restored.id) ?? []) });
});
