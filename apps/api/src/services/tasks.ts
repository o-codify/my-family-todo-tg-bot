import { and, eq, isNull } from 'drizzle-orm';
import type { CreateTaskInput, UpdateTaskInput } from '@family-todo/shared';
import { db } from '../db/client';
import { tasks, type TaskRow } from '../db/schema';
import { logger } from '../logger';
import {
  cancelRemindersForTask,
  scheduleRemindersForTask,
} from '../queue/reminder';
import { publishFamilyEvent } from '../realtime/pubsub';
import { clearFutureOccurrences, inputToSubtaskTemplate, syncOccurrencesForTask } from './occurrences';
import { ensureQueuedOccurrence } from './queue-tasks';
import { setTaskTags } from './tags';

/**
 * Normalize the participant list for a shared task. Participants are only
 * meaningful for oneoff/recurring tasks; the assignee is the responsible and
 * is implicitly a participant, so we strip them out of the explicit list.
 * Returns null (= solo task) for unsupported types or an empty result.
 */
function normalizeParticipants(
  type: TaskRow['type'],
  assigneeId: string | null,
  participantIds: string[] | null | undefined,
): string[] | null {
  if (type !== 'oneoff' && type !== 'recurring') return null;
  if (!participantIds || participantIds.length === 0) return null;
  const cleaned = [...new Set(participantIds)].filter((id) => id && id !== assigneeId);
  return cleaned.length > 0 ? cleaned : null;
}

export async function listFamilyTasks(familyId: string): Promise<TaskRow[]> {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.familyId, familyId), isNull(tasks.archivedAt)));
}

export async function getTaskInFamily(taskId: string, familyId: string): Promise<TaskRow | null> {
  const row = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.familyId, familyId)),
  });
  return row ?? null;
}

export async function createTask(input: {
  familyId: string;
  createdBy: string;
  data: CreateTaskInput;
}): Promise<TaskRow> {
  const { data } = input;

  // Auto-balance: when the caller asked for it AND didn't pin a specific
  // assignee, pick the least-loaded member. Returning null (everyone is
  // away) leaves the task unassigned, which is a saner fallback than
  // forcing it onto an away member.
  let assigneeId = data.assigneeId ?? null;
  if (data.autoAssign && !assigneeId) {
    const { pickAutoAssignee } = await import('./auto-balance');
    assigneeId = await pickAutoAssignee({ familyId: input.familyId });
  }

  const task = await db.transaction(async (tx) => {
    const [t] = await tx
      .insert(tasks)
      .values({
        familyId: input.familyId,
        title: data.title.trim(),
        description: data.description?.trim() ?? null,
        type: data.type,
        schedule: data.schedule,
        assigneeId,
        queueUserIds: data.queueUserIds ?? null,
        participantIds: normalizeParticipants(data.type, assigneeId, data.participantIds),
        deadlineAt: data.deadlineAt ? new Date(data.deadlineAt) : null,
        points: data.points,
        photoRequired: data.photoRequired,
        requiresApproval: data.requiresApproval,
        isQuest: data.isQuest,
        singleShot: data.singleShot,
        cooldownDays: data.cooldownDays ?? null,
        subtasksTemplate: inputToSubtaskTemplate(data.subtasks),
        createdBy: input.createdBy,
      })
      .returning();

    await syncOccurrencesForTask(t!, tx);
    if (t!.type === 'queued') {
      await ensureQueuedOccurrence(t!, tx);
    }
    return t!;
  });

  // Attach tags after the task insert tx — runs in its own tx so a tag
  // miss (e.g. caller passed a stale id) doesn't roll back the task.
  // Missing/stranger tag ids are silently dropped by the FK check on
  // the join row, which is the right behaviour for a soft "add label" UX.
  if (data.tagIds && data.tagIds.length > 0) {
    await setTaskTags(task.id, data.tagIds);
  }

  // Schedule reminders after the tx commits — the BullMQ producer holds a
  // separate Redis connection, and we don't want a Redis hiccup to roll
  // back the task insert.
  void scheduleRemindersForTask(task.id).catch((err) =>
    logger.warn({ err, taskId: task.id }, 'createTask: schedule reminders failed'),
  );
  void publishFamilyEvent(task.familyId, { kind: 'invalidate', scope: 'tasks' });

  return task;
}

export async function updateTask(input: {
  task: TaskRow;
  data: UpdateTaskInput;
}): Promise<TaskRow> {
  const { task, data } = input;

  const next: Partial<typeof tasks.$inferInsert> = { updatedAt: new Date() };
  if (data.title !== undefined) next.title = data.title.trim();
  if (data.description !== undefined) next.description = data.description?.trim() ?? null;
  if (data.type !== undefined) next.type = data.type;
  if (data.schedule !== undefined) next.schedule = data.schedule;
  if (data.assigneeId !== undefined) next.assigneeId = data.assigneeId ?? null;
  if (data.queueUserIds !== undefined) next.queueUserIds = data.queueUserIds ?? null;

  // Participants depend on the effective type + assignee, both of which can
  // change in the same patch. Recompute when the list is supplied, when the
  // type switches away from a participant-capable one, or when the assignee
  // changes (a new assignee must be stripped from an existing list).
  const effType = data.type ?? task.type;
  const effAssignee =
    data.assigneeId !== undefined ? (data.assigneeId ?? null) : task.assigneeId;
  if (data.participantIds !== undefined) {
    next.participantIds = normalizeParticipants(effType, effAssignee, data.participantIds);
  } else if (
    (data.type !== undefined && effType !== 'oneoff' && effType !== 'recurring') ||
    (data.assigneeId !== undefined && (task.participantIds?.length ?? 0) > 0)
  ) {
    next.participantIds = normalizeParticipants(effType, effAssignee, task.participantIds);
  }
  if (data.deadlineAt !== undefined) {
    next.deadlineAt = data.deadlineAt ? new Date(data.deadlineAt) : null;
  }
  if (data.points !== undefined) next.points = data.points;
  if (data.photoRequired !== undefined) next.photoRequired = data.photoRequired;
  if (data.requiresApproval !== undefined) next.requiresApproval = data.requiresApproval;
  if (data.isQuest !== undefined) next.isQuest = data.isQuest;
  if (data.singleShot !== undefined) next.singleShot = data.singleShot;
  if (data.cooldownDays !== undefined) next.cooldownDays = data.cooldownDays ?? null;
  if (data.subtasks !== undefined) next.subtasksTemplate = inputToSubtaskTemplate(data.subtasks);

  const scheduleChanged = data.schedule !== undefined || data.type !== undefined;
  // Also re-schedule reminders when assignee/time-bearing fields change —
  // assignee determines who gets the notification, and time changes shift
  // the fire moment. Easier to bulk-reschedule than detect granular changes.
  const remindersAffected =
    scheduleChanged ||
    data.assigneeId !== undefined ||
    data.queueUserIds !== undefined;

  const updated = await db.transaction(async (tx) => {
    const [u] = await tx.update(tasks).set(next).where(eq(tasks.id, task.id)).returning();
    if (scheduleChanged) {
      await clearFutureOccurrences(u!.id, tx);
      await syncOccurrencesForTask(u!, tx);
      // syncOccurrencesForTask is a no-op for queued tasks (they're
      // date-less and only ever have one pending row at a time). After
      // clearing future occurrences we'd be left with no pending row at
      // all — which made the task vanish from Calendar/Day. Mirror the
      // createTask path: spawn the next pending turn explicitly.
      if (u!.type === 'queued') {
        await ensureQueuedOccurrence(u!, tx);
      }
    } else if (data.queueUserIds !== undefined && u!.type === 'queued') {
      // Edited the queue roster without changing the schedule. The
      // existing pending row may now be assigned to someone who's no
      // longer in the queue — recompute the assignee.
      await ensureQueuedOccurrence(u!, tx);
    }
    return u!;
  });

  // Tag changes are independent of schedule/assignee — rewrite the
  // join rows only when the caller actually passed `tagIds`. Undefined
  // means "leave them alone"; an empty array means "clear all".
  if (data.tagIds !== undefined) {
    await setTaskTags(updated.id, data.tagIds);
  }

  if (remindersAffected) {
    void (async () => {
      try {
        await cancelRemindersForTask(updated.id);
        await scheduleRemindersForTask(updated.id);
      } catch (err) {
        logger.warn({ err, taskId: updated.id }, 'updateTask: reminders re-schedule failed');
      }
    })();
  }
  void publishFamilyEvent(updated.familyId, { kind: 'invalidate', scope: 'tasks' });
  if (scheduleChanged) {
    void publishFamilyEvent(updated.familyId, { kind: 'invalidate', scope: 'occurrences' });
  }

  return updated;
}

/**
 * Undo of `archiveTask`. Flips `archivedAt` back to null and regenerates
 * the task's future occurrences (archive wiped them). Reminders are
 * re-scheduled after commit, mirroring `createTask`.
 *
 * Intended for the "Удалено · Отменить" toast in the miniapp — restore
 * window is short (5s) but we don't enforce that here; the caller decides
 * when restore is OK.
 */
export async function restoreTask(taskId: string): Promise<TaskRow | null> {
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  if (!task || !task.archivedAt) return task ?? null;

  const restored = await db.transaction(async (tx) => {
    const [t] = await tx
      .update(tasks)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(eq(tasks.id, taskId))
      .returning();
    if (!t) return null;
    await syncOccurrencesForTask(t, tx);
    if (t.type === 'queued') {
      await ensureQueuedOccurrence(t, tx);
    }
    return t;
  });

  if (restored) {
    void scheduleRemindersForTask(restored.id).catch((err) =>
      logger.warn({ err, taskId: restored.id }, 'restoreTask: schedule reminders failed'),
    );
    void publishFamilyEvent(restored.familyId, { kind: 'invalidate', scope: 'tasks' });
    void publishFamilyEvent(restored.familyId, { kind: 'invalidate', scope: 'occurrences' });
  }
  return restored;
}

export async function archiveTask(taskId: string): Promise<void> {
  // Cancel reminders BEFORE we delete the occurrence rows — the cancel
  // helper looks them up by id.
  await cancelRemindersForTask(taskId).catch((err) =>
    logger.warn({ err, taskId }, 'archiveTask: cancel reminders failed'),
  );
  // Capture familyId for the publish *before* archive — once `archivedAt`
  // is set, the row still exists, so this is mostly belt-and-braces.
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  await db.transaction(async (tx) => {
    await tx.update(tasks).set({ archivedAt: new Date() }).where(eq(tasks.id, taskId));
    await clearFutureOccurrences(taskId, tx);
  });
  if (task) {
    void publishFamilyEvent(task.familyId, { kind: 'invalidate', scope: 'tasks' });
    void publishFamilyEvent(task.familyId, { kind: 'invalidate', scope: 'occurrences' });
  }
}

/** Per-queue-task completion stats. Authoritative source for the
 *  per-user count + last completer; the client used to derive these
 *  from its windowed occurrences fetch, which dropped completions
 *  older than the visible grid (the user reported "у каждого должно
 *  быть 1-2, а отображает 0-1; задач старее 30 мая не видно вообще"
 *  on a queue that started May 24). Computing server-side reads the
 *  full history regardless of any frontend window. */
export type QueueStats = {
  /** userId → number of done occurrences attributed to that user. */
  completionsByUser: Record<string, number>;
  /** Latest done occurrence's `completedBy`, or null if no one's
   *  completed this task yet. Drives the strict-alternation tie-break
   *  in pickNextAssignee. */
  lastCompleterId: string | null;
  /** Latest done occurrence's `completedAt` ISO. Lets the client
   *  anchor its cooldown / forecast cursor correctly. */
  lastCompletedAt: string | null;
};

export function serializeTask(
  row: TaskRow,
  tagIds: string[] = [],
  queueStats: QueueStats | null = null,
) {
  return {
    id: row.id,
    familyId: row.familyId,
    title: row.title,
    description: row.description,
    type: row.type,
    schedule: row.schedule,
    assigneeId: row.assigneeId,
    queueUserIds: row.queueUserIds,
    participantIds: row.participantIds,
    deadlineAt: row.deadlineAt?.toISOString() ?? null,
    points: row.points,
    photoRequired: row.photoRequired,
    requiresApproval: row.requiresApproval,
    isQuest: row.isQuest,
    singleShot: row.singleShot,
    cooldownDays: row.cooldownDays,
    subtasksTemplate: row.subtasksTemplate,
    createdBy: row.createdBy,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    tagIds,
    queueStats,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
