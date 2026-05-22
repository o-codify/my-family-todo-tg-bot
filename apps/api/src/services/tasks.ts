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

  const task = await db.transaction(async (tx) => {
    const [t] = await tx
      .insert(tasks)
      .values({
        familyId: input.familyId,
        title: data.title.trim(),
        description: data.description?.trim() ?? null,
        type: data.type,
        schedule: data.schedule,
        assigneeId: data.assigneeId ?? null,
        queueUserIds: data.queueUserIds ?? null,
        deadlineAt: data.deadlineAt ? new Date(data.deadlineAt) : null,
        points: data.points,
        photoRequired: data.photoRequired,
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
  if (data.deadlineAt !== undefined) {
    next.deadlineAt = data.deadlineAt ? new Date(data.deadlineAt) : null;
  }
  if (data.points !== undefined) next.points = data.points;
  if (data.photoRequired !== undefined) next.photoRequired = data.photoRequired;
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

export function serializeTask(row: TaskRow) {
  return {
    id: row.id,
    familyId: row.familyId,
    title: row.title,
    description: row.description,
    type: row.type,
    schedule: row.schedule,
    assigneeId: row.assigneeId,
    queueUserIds: row.queueUserIds,
    deadlineAt: row.deadlineAt?.toISOString() ?? null,
    points: row.points,
    photoRequired: row.photoRequired,
    singleShot: row.singleShot,
    cooldownDays: row.cooldownDays,
    subtasksTemplate: row.subtasksTemplate,
    createdBy: row.createdBy,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
