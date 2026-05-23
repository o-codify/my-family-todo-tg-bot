import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import {
  completeOccurrenceSchema,
  occurrencesQuerySchema,
  rescheduleOccurrenceSchema,
  updateSubtasksStateSchema,
} from '@family-todo/shared';
import { tgAuth, type AuthVariables } from '../middleware/auth';
import { requireFamily, type FamilyVariables } from '../middleware/family';
import {
  approveOccurrence,
  completeOccurrence,
  getOccurrenceInFamily,
  listFamilyOccurrences,
  listPendingApprovals,
  OccurrenceActionError,
  patchOccurrenceSubtasks,
  rejectOccurrence,
  rescheduleOccurrence,
  serializeOccurrence,
  uncompleteOccurrence,
} from '../services/occurrence-actions';

export const occurrencesRouter = new Hono<{ Variables: AuthVariables & FamilyVariables }>()
  .use('*', tgAuth)
  .use('*', requireFamily);

occurrencesRouter.get('/', zValidator('query', occurrencesQuerySchema), async (c) => {
  const familyId = c.get('familyId');
  const query = c.req.valid('query');
  const rows = await listFamilyOccurrences(familyId, query);
  return c.json({ occurrences: rows.map(serializeOccurrence) });
});

/**
 * Single-occurrence fetch. Used by pages that need to survive a refresh —
 * e.g. the Transfer page identifies its occurrence by id in the URL and
 * needs to fetch the full row on cold start.
 */
occurrencesRouter.get('/:occurrenceId', async (c) => {
  const familyId = c.get('familyId');
  const occ = await getOccurrenceInFamily(c.req.param('occurrenceId'), familyId);
  if (!occ) return c.json({ error: 'occurrence_not_found' }, 404);
  return c.json({ occurrence: serializeOccurrence(occ) });
});

occurrencesRouter.post(
  '/:occurrenceId/complete',
  zValidator('json', completeOccurrenceSchema),
  async (c) => {
    const user = c.get('user');
    const familyId = c.get('familyId');
    const occ = await getOccurrenceInFamily(c.req.param('occurrenceId'), familyId);
    if (!occ) return c.json({ error: 'occurrence_not_found' }, 404);

    const isAssignee = occ.assigneeId === user.id;
    if (!isAssignee && !c.get('permissions').includes('task.complete.any')) {
      return c.json({ error: 'forbidden', permission: 'task.complete.any' }, 403);
    }

    try {
      const updated = await completeOccurrence({
        occurrence: occ,
        userId: user.id,
        data: c.req.valid('json'),
      });
      return c.json({ occurrence: serializeOccurrence({ ...updated, task: occ.task }) });
    } catch (err) {
      if (err instanceof OccurrenceActionError) {
        return c.json({ error: err.code }, 400);
      }
      throw err;
    }
  },
);

/**
 * Toggle subtask done-state without completing the whole occurrence.
 * Body: { patch: [{ id, done }, …] }.
 */
occurrencesRouter.patch(
  '/:occurrenceId/subtasks',
  zValidator('json', updateSubtasksStateSchema),
  async (c) => {
    const user = c.get('user');
    const familyId = c.get('familyId');
    const occ = await getOccurrenceInFamily(c.req.param('occurrenceId'), familyId);
    if (!occ) return c.json({ error: 'occurrence_not_found' }, 404);

    const isAssignee = occ.assigneeId === user.id;
    if (!isAssignee && !c.get('permissions').includes('task.complete.any')) {
      return c.json({ error: 'forbidden', permission: 'task.complete.any' }, 403);
    }

    try {
      const updated = await patchOccurrenceSubtasks({
        occurrence: occ,
        patch: c.req.valid('json').patch,
      });
      if (!updated) return c.json({ error: 'no_subtasks' }, 400);
      return c.json({ occurrence: serializeOccurrence({ ...updated, task: occ.task }) });
    } catch (err) {
      if (err instanceof OccurrenceActionError) {
        return c.json({ error: err.code }, 409);
      }
      throw err;
    }
  },
);

/**
 * Move a pending occurrence to another calendar date. Used by the
 * "Reschedule" button in TaskSheet. Permission: assignee or
 * `task.complete.any`. 409 on date_conflict, 400 on wrong_task_type/done.
 */
occurrencesRouter.post(
  '/:occurrenceId/reschedule',
  zValidator('json', rescheduleOccurrenceSchema),
  async (c) => {
    const user = c.get('user');
    const familyId = c.get('familyId');
    const occ = await getOccurrenceInFamily(c.req.param('occurrenceId'), familyId);
    if (!occ) return c.json({ error: 'occurrence_not_found' }, 404);

    const isAssignee = occ.assigneeId === user.id;
    if (!isAssignee && !c.get('permissions').includes('task.complete.any')) {
      return c.json({ error: 'forbidden', permission: 'task.complete.any' }, 403);
    }

    try {
      const updated = await rescheduleOccurrence({
        occurrence: occ,
        scheduledDate: c.req.valid('json').scheduledDate,
      });
      return c.json({ occurrence: serializeOccurrence({ ...updated, task: occ.task }) });
    } catch (err) {
      if (err instanceof OccurrenceActionError) {
        const status = err.code === 'date_conflict' ? 409 : 400;
        return c.json({ error: err.code }, status);
      }
      throw err;
    }
  },
);

/** List 'pending_approval' occurrences in the family. Caller must hold
 *  the `task.approve` permission (Inbox surfaces this section to
 *  approvers only). */
occurrencesRouter.get('/pending-approvals/list', async (c) => {
  if (!c.get('permissions').includes('task.approve')) {
    return c.json({ error: 'forbidden', permission: 'task.approve' }, 403);
  }
  const rows = await listPendingApprovals(c.get('familyId'));
  return c.json({ occurrences: rows.map(serializeOccurrence) });
});

occurrencesRouter.post('/:occurrenceId/approve', async (c) => {
  if (!c.get('permissions').includes('task.approve')) {
    return c.json({ error: 'forbidden', permission: 'task.approve' }, 403);
  }
  const user = c.get('user');
  const familyId = c.get('familyId');
  const occ = await getOccurrenceInFamily(c.req.param('occurrenceId'), familyId);
  if (!occ) return c.json({ error: 'occurrence_not_found' }, 404);
  try {
    const updated = await approveOccurrence({
      occurrenceId: occ.id,
      approverId: user.id,
    });
    if (!updated) return c.json({ error: 'occurrence_not_found' }, 404);
    return c.json({ occurrence: serializeOccurrence({ ...updated, task: occ.task }) });
  } catch (err) {
    if (err instanceof OccurrenceActionError) {
      return c.json({ error: err.code }, 409);
    }
    throw err;
  }
});

occurrencesRouter.post('/:occurrenceId/reject', async (c) => {
  if (!c.get('permissions').includes('task.approve')) {
    return c.json({ error: 'forbidden', permission: 'task.approve' }, 403);
  }
  const user = c.get('user');
  const familyId = c.get('familyId');
  const occ = await getOccurrenceInFamily(c.req.param('occurrenceId'), familyId);
  if (!occ) return c.json({ error: 'occurrence_not_found' }, 404);
  // Reason is optional, plain text. We don't enforce schema validation
  // here — body is small and the field is non-critical.
  let reason: string | null = null;
  try {
    const body = (await c.req.json()) as { reason?: string };
    if (typeof body?.reason === 'string') reason = body.reason;
  } catch {
    // Empty body is fine.
  }
  try {
    const updated = await rejectOccurrence({
      occurrenceId: occ.id,
      rejecterId: user.id,
      reason,
    });
    if (!updated) return c.json({ error: 'occurrence_not_found' }, 404);
    return c.json({ occurrence: serializeOccurrence({ ...updated, task: occ.task }) });
  } catch (err) {
    if (err instanceof OccurrenceActionError) {
      return c.json({ error: err.code }, 409);
    }
    throw err;
  }
});

occurrencesRouter.post('/:occurrenceId/uncomplete', async (c) => {
  const user = c.get('user');
  const familyId = c.get('familyId');
  const occ = await getOccurrenceInFamily(c.req.param('occurrenceId'), familyId);
  if (!occ) return c.json({ error: 'occurrence_not_found' }, 404);

  const isCompleter = occ.completedBy === user.id;
  if (!isCompleter && !c.get('permissions').includes('task.complete.any')) {
    return c.json({ error: 'forbidden', permission: 'task.complete.any' }, 403);
  }

  const updated = await uncompleteOccurrence(occ.id);
  if (!updated) return c.json({ error: 'occurrence_not_found' }, 404);
  return c.json({ occurrence: serializeOccurrence({ ...updated, task: occ.task }) });
});
