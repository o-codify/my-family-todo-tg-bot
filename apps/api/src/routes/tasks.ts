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
import { diffTaskFields, recordAuditEvent } from '../services/audit-log';
import {
  getQueueStatsForTasks,
  type QueueStatsRow,
} from '../services/queue-tasks';
import type { QueueStats } from '../services/tasks';

/** Build a queueStats DTO blob for serialisation. Empty/null stats
 *  collapse to "no completions yet" so the client never has to guard
 *  for absent map entries. Date -> ISO so the wire stays JSON-clean. */
function queueStatsToDto(stats: QueueStatsRow | null): QueueStats {
  if (!stats) {
    return {
      completionsByUser: {},
      lastCompleterId: null,
      lastCompletedAt: null,
    };
  }
  return {
    completionsByUser: stats.completionsByUser,
    lastCompleterId: stats.lastCompleterId,
    lastCompletedAt: stats.lastCompletedAt?.toISOString() ?? null,
  };
}

/** Batch-load queue stats only for queued tasks in the list; non-queue
 *  rows return null (serialiser sends `queueStats: null` for those). */
async function loadQueueStatsByTaskId(
  tasks: { id: string; type: string }[],
): Promise<Map<string, QueueStats | null>> {
  const map = new Map<string, QueueStats | null>();
  const queueIds = tasks.filter((t) => t.type === 'queued').map((t) => t.id);
  if (queueIds.length === 0) return map;
  const raw = await getQueueStatsForTasks(queueIds);
  for (const id of queueIds) {
    map.set(id, queueStatsToDto(raw.get(id) ?? null));
  }
  return map;
}

export const tasksRouter = new Hono<{ Variables: AuthVariables & FamilyVariables }>()
  .use('*', tgAuth)
  .use('*', requireFamily);

tasksRouter.get('/', async (c) => {
  const familyId = c.get('familyId');
  const tasks = await listFamilyTasks(familyId);
  // Batch-lookup tag attachments + queue stats so we don't run N+1
  // queries during serialisation. Tasks without any tags just get an
  // empty array; non-queue tasks get a null queueStats.
  const [tagMap, queueStatsMap] = await Promise.all([
    getTagIdsForTasks(tasks.map((t) => t.id)),
    loadQueueStatsByTaskId(tasks),
  ]);
  return c.json({
    tasks: tasks.map((t) =>
      serializeTask(t, tagMap.get(t.id) ?? [], queueStatsMap.get(t.id) ?? null),
    ),
  });
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
    const [tagMap, queueStatsMap] = await Promise.all([
      getTagIdsForTasks([task.id]),
      loadQueueStatsByTaskId([task]),
    ]);
    void recordAuditEvent({
      familyId,
      actorUserId: user.id,
      kind: 'task.create',
      entityType: 'task',
      entityId: task.id,
      entityTitle: task.title,
      details: { taskType: task.type },
    });
    return c.json(
      {
        task: serializeTask(
          task,
          tagMap.get(task.id) ?? [],
          queueStatsMap.get(task.id) ?? null,
        ),
      },
      201,
    );
  },
);

tasksRouter.get('/:taskId', async (c) => {
  const familyId = c.get('familyId');
  const task = await getTaskInFamily(c.req.param('taskId'), familyId);
  if (!task) return c.json({ error: 'task_not_found' }, 404);
  const [tagMap, queueStatsMap] = await Promise.all([
    getTagIdsForTasks([task.id]),
    loadQueueStatsByTaskId([task]),
  ]);
  return c.json({
    task: serializeTask(
      task,
      tagMap.get(task.id) ?? [],
      queueStatsMap.get(task.id) ?? null,
    ),
  });
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
    const [tagMap, queueStatsMap] = await Promise.all([
      getTagIdsForTasks([updated.id]),
      loadQueueStatsByTaskId([updated]),
    ]);
    const changedFields = diffTaskFields(task, updated);
    // Only emit an audit row when something material actually
    // changed — a no-op PATCH (e.g. the client re-saving the same
    // form) shouldn't clutter the History timeline.
    if (changedFields.length > 0) {
      void recordAuditEvent({
        familyId,
        actorUserId: user.id,
        kind: 'task.update',
        entityType: 'task',
        entityId: updated.id,
        entityTitle: updated.title,
        details: { changedFields },
      });
    }
    return c.json({
      task: serializeTask(
        updated,
        tagMap.get(updated.id) ?? [],
        queueStatsMap.get(updated.id) ?? null,
      ),
    });
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
  void recordAuditEvent({
    familyId,
    actorUserId: user.id,
    kind: 'task.delete',
    entityType: 'task',
    entityId: task.id,
    entityTitle: task.title,
  });
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
  const [tagMap, queueStatsMap] = await Promise.all([
    getTagIdsForTasks([restored.id]),
    loadQueueStatsByTaskId([restored]),
  ]);
  void recordAuditEvent({
    familyId,
    actorUserId: user.id,
    kind: 'task.restore',
    entityType: 'task',
    entityId: restored.id,
    entityTitle: restored.title,
  });
  return c.json({
    task: serializeTask(
      restored,
      tagMap.get(restored.id) ?? [],
      queueStatsMap.get(restored.id) ?? null,
    ),
  });
});
