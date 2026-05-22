import { and, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import type { CompleteOccurrenceInput, OccurrencesQuery } from '@family-todo/shared';
import { db } from '../db/client';
import {
  pointsLedger,
  taskOccurrences,
  tasks,
  type SubtaskStateItem,
  type TaskOccurrenceRow,
  type TaskRow,
} from '../db/schema';
import { logger } from '../logger';
import {
  cancelReminderForOccurrence,
  scheduleReminderForOccurrence,
} from '../queue/reminder';
import { publishFamilyEvent } from '../realtime/pubsub';
import { decideAfterFloatingCompletion, isFloatingAvailable } from './cooldown';
import { ensureQueuedOccurrence } from './queue-tasks';
import { awardPointsForCompletion } from './rewards';

const DAY_MS = 24 * 60 * 60 * 1000;

export type OccurrenceWithTask = TaskOccurrenceRow & { task: TaskRow };

function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Returns occurrences for a family in a date range, joined with task metadata.
 * `from` and `to` are inclusive YYYY-MM-DD; defaults to current month +/- 7 days.
 */
export async function listFamilyOccurrences(
  familyId: string,
  query: OccurrencesQuery,
): Promise<OccurrenceWithTask[]> {
  const fromDate = query.from ?? isoDate(new Date(Date.now() - 7 * DAY_MS));
  const toDate = query.to ?? isoDate(new Date(Date.now() + 31 * DAY_MS));

  // Floating completions live with `scheduled_date = NULL` (see the comment in
  // completeFloatingTask). To keep the Day/Calendar query date-bound while
  // still surfacing today's null-dated completions, we union three buckets:
  //   1. Pending null-date rows — always (these are "Когда-нибудь" tasks).
  //   2. Dated rows — within the requested scheduled-date range.
  //   3. Done null-date rows — only when their completedAt falls in range.
  const fromTs = new Date(`${fromDate}T00:00:00.000Z`);
  const toTs = new Date(`${toDate}T23:59:59.999Z`);
  const conditions = [
    eq(tasks.familyId, familyId),
    isNull(tasks.archivedAt),
    or(
      and(isNull(taskOccurrences.scheduledDate), eq(taskOccurrences.status, 'pending')),
      and(
        gte(taskOccurrences.scheduledDate, fromDate),
        lte(taskOccurrences.scheduledDate, toDate),
      ),
      and(
        isNull(taskOccurrences.scheduledDate),
        eq(taskOccurrences.status, 'done'),
        gte(taskOccurrences.completedAt, fromTs),
        lte(taskOccurrences.completedAt, toTs),
      ),
    )!,
  ];

  if (query.assignee) {
    conditions.push(eq(taskOccurrences.assigneeId, query.assignee));
  }

  const rows = await db
    .select({ occurrence: taskOccurrences, task: tasks })
    .from(taskOccurrences)
    .innerJoin(tasks, eq(taskOccurrences.taskId, tasks.id))
    .where(and(...conditions));

  return rows.map(({ occurrence, task }) => ({ ...occurrence, task }));
}

export async function getOccurrenceInFamily(
  occurrenceId: string,
  familyId: string,
): Promise<OccurrenceWithTask | null> {
  const rows = await db
    .select({ occurrence: taskOccurrences, task: tasks })
    .from(taskOccurrences)
    .innerJoin(tasks, eq(taskOccurrences.taskId, tasks.id))
    .where(and(eq(taskOccurrences.id, occurrenceId), eq(tasks.familyId, familyId)))
    .limit(1);

  const first = rows[0];
  return first ? { ...first.occurrence, task: first.task } : null;
}

function mergeSubtasksState(
  current: SubtaskStateItem[] | null,
  patch: CompleteOccurrenceInput['subtasksState'],
): SubtaskStateItem[] | null {
  if (!current) return null;
  if (!patch?.length) return current;
  const byId = new Map(patch.map((p) => [p.id, p.done] as const));
  return current.map((s) => (byId.has(s.id) ? { ...s, done: byId.get(s.id)! } : s));
}

/**
 * Patch subtask done-state for a pending occurrence. Used when the user
 * ticks off subtasks one by one before hitting "Done" on the whole task.
 *
 * Returns the updated row or null if nothing to merge (e.g. occurrence has
 * no subtasks template). Caller is responsible for the auth check.
 */
export async function patchOccurrenceSubtasks(input: {
  occurrence: OccurrenceWithTask;
  patch: NonNullable<CompleteOccurrenceInput['subtasksState']>;
}): Promise<TaskOccurrenceRow | null> {
  const merged = mergeSubtasksState(input.occurrence.subtasks, input.patch);
  if (!merged) return null;
  const [updated] = await db
    .update(taskOccurrences)
    .set({ subtasks: merged })
    .where(eq(taskOccurrences.id, input.occurrence.id))
    .returning();
  return updated ?? null;
}

export async function completeOccurrence(input: {
  occurrence: OccurrenceWithTask;
  userId: string;
  data: CompleteOccurrenceInput;
}): Promise<TaskOccurrenceRow> {
  const { occurrence, userId, data } = input;

  if (occurrence.task.photoRequired && (!data.photoIds || data.photoIds.length === 0)) {
    throw new OccurrenceActionError('photo_required');
  }

  const subtasksState = mergeSubtasksState(occurrence.subtasks, data.subtasksState);
  const hasIncomplete = subtasksState?.some((s) => !s.done);
  if (hasIncomplete) {
    throw new OccurrenceActionError('subtasks_incomplete');
  }

  const [updated] = await db
    .update(taskOccurrences)
    .set({
      status: 'done',
      completedAt: new Date(),
      completedBy: userId,
      photoIds: data.photoIds ?? null,
      pointsAwarded: occurrence.task.points,
      subtasks: subtasksState,
    })
    .where(eq(taskOccurrences.id, occurrence.id))
    .returning();

  // Award points for the completion.
  if (occurrence.task.points > 0) {
    await awardPointsForCompletion({
      familyId: occurrence.task.familyId,
      userId,
      points: occurrence.task.points,
      completionId: updated!.id,
    });
  }

  // For queued tasks: spawn the next round with the next assignee.
  if (occurrence.task.type === 'queued') {
    await ensureQueuedOccurrence(occurrence.task);
  }

  // Reminder is moot once the task is done. Best-effort cancel.
  void cancelReminderForOccurrence(occurrence.id).catch((err) =>
    logger.warn({ err, occurrenceId: occurrence.id }, 'cancel reminder on complete failed'),
  );
  void publishFamilyEvent(occurrence.task.familyId, { kind: 'invalidate', scope: 'occurrences' });

  return updated!;
}

export async function uncompleteOccurrence(
  occurrenceId: string,
): Promise<TaskOccurrenceRow | null> {
  const [updated] = await db
    .update(taskOccurrences)
    .set({
      status: 'pending',
      completedAt: null,
      completedBy: null,
      photoIds: null,
      pointsAwarded: 0,
    })
    .where(eq(taskOccurrences.id, occurrenceId))
    .returning();
  // Re-schedule the reminder if the occurrence is still in the future. The
  // helper handles all the "is it eligible?" checks — we just trigger it.
  if (updated) {
    void scheduleReminderForOccurrence(updated.id).catch((err) =>
      logger.warn({ err, occurrenceId }, 'reschedule reminder on uncomplete failed'),
    );
    // We need the familyId to publish; look it up via the task.
    void (async () => {
      const t = await db.query.tasks.findFirst({ where: eq(tasks.id, updated.taskId) });
      if (t) await publishFamilyEvent(t.familyId, { kind: 'invalidate', scope: 'occurrences' });
    })().catch(() => undefined);
  }
  return updated ?? null;
}

export class OccurrenceActionError extends Error {
  constructor(
    public readonly code:
      | 'photo_required'
      | 'subtasks_incomplete'
      | 'wrong_task_type'
      | 'task_archived'
      | 'already_done'
      | 'date_conflict',
  ) {
    super(code);
    this.name = 'OccurrenceActionError';
  }
}

/**
 * Move a pending occurrence to a different calendar date. Refuses to act on
 * already-done occurrences or floating-task occurrences (those are date-less
 * by design). The unique index `(task_id, scheduled_date)` is enforced by the
 * DB — we surface 23505 collisions as `date_conflict` so the UI can show a
 * sensible message.
 */
export async function rescheduleOccurrence(input: {
  occurrence: OccurrenceWithTask;
  scheduledDate: string;
}): Promise<TaskOccurrenceRow> {
  const { occurrence, scheduledDate } = input;
  if (occurrence.status === 'done') throw new OccurrenceActionError('already_done');
  if (occurrence.task.type === 'floating') {
    throw new OccurrenceActionError('wrong_task_type');
  }
  if (occurrence.scheduledDate === scheduledDate) return occurrence;
  try {
    const [updated] = await db
      .update(taskOccurrences)
      .set({ scheduledDate })
      .where(eq(taskOccurrences.id, occurrence.id))
      .returning();
    if (!updated) throw new OccurrenceActionError('already_done');
    // The fire moment moved — replace the BullMQ job. Best-effort.
    void scheduleReminderForOccurrence(updated.id).catch((err) =>
      logger.warn({ err, occurrenceId: updated.id }, 'reschedule reminder failed'),
    );
    void publishFamilyEvent(occurrence.task.familyId, {
      kind: 'invalidate',
      scope: 'occurrences',
    });
    return updated;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new OccurrenceActionError('date_conflict');
    }
    throw err;
  }
}

/**
 * Completes a floating task. Floating tasks have no calendar occurrences until
 * completion: this function creates the completion record AND, depending on
 * single_shot/cooldown config, either archives the task or seeds the next
 * pending occurrence with `available_at` set.
 */
export async function completeFloatingTask(input: {
  task: TaskRow;
  userId: string;
  data: CompleteOccurrenceInput;
}): Promise<TaskOccurrenceRow> {
  const { task, userId, data } = input;
  if (task.type !== 'floating') throw new OccurrenceActionError('wrong_task_type');
  if (task.archivedAt) throw new OccurrenceActionError('task_archived');

  if (task.photoRequired && (!data.photoIds || data.photoIds.length === 0)) {
    throw new OccurrenceActionError('photo_required');
  }

  const today = new Date();

  return db.transaction(async (tx) => {
    // Block completion if the latest pending occurrence is still on cooldown.
    const pending = await tx
      .select()
      .from(taskOccurrences)
      .where(and(eq(taskOccurrences.taskId, task.id), eq(taskOccurrences.status, 'pending')))
      .limit(1);
    if (pending[0] && !isFloatingAvailable({ availableAt: pending[0].availableAt, now: today })) {
      throw new OccurrenceActionError('task_archived'); // misnomer ok — frontend treats as "not yet"
    }

    // IMPORTANT: leave `scheduledDate` as NULL for floating completions.
    //
    // Earlier we stamped `scheduledDate = todayIso` here so the calendar/day
    // query could surface today's completion under today's date column. That
    // caused a 500 (unique constraint `occurrences_task_date_unique`) the
    // moment the same task was completed twice in one day: the first run
    // inserted a done row at (task_id, today) and reopened a fresh pending
    // (null date); the second run then tried to UPDATE that pending row's
    // scheduled_date to today and collided with the existing done row.
    //
    // Floating completions are intrinsically date-less — we anchor them to a
    // day via `completedAt` instead, and the list filter
    // (listFamilyOccurrences) joins null-dated done rows by completedAt range.
    let completedRow: TaskOccurrenceRow;
    if (pending[0]) {
      const [updated] = await tx
        .update(taskOccurrences)
        .set({
          status: 'done',
          completedAt: today,
          completedBy: userId,
          photoIds: data.photoIds ?? null,
          pointsAwarded: task.points,
        })
        .where(eq(taskOccurrences.id, pending[0].id))
        .returning();
      completedRow = updated!;
    } else {
      const [inserted] = await tx
        .insert(taskOccurrences)
        .values({
          taskId: task.id,
          status: 'done',
          completedAt: today,
          completedBy: userId,
          photoIds: data.photoIds ?? null,
          pointsAwarded: task.points,
        })
        .returning();
      completedRow = inserted!;
    }

    const decision = decideAfterFloatingCompletion({
      singleShot: task.singleShot,
      cooldownDays: task.cooldownDays,
      completedAt: today,
    });

    if (decision.kind === 'archive') {
      await tx.update(tasks).set({ archivedAt: today }).where(eq(tasks.id, task.id));
    } else if (decision.kind === 'wait_then_reopen') {
      await tx.insert(taskOccurrences).values({
        taskId: task.id,
        status: 'pending',
        availableAt: decision.availableAt,
      });
    } else {
      // reopen_immediately
      await tx.insert(taskOccurrences).values({ taskId: task.id, status: 'pending' });
    }

    // Award points (kept inside the tx so the ledger stays consistent with
    // the occurrence write — both succeed or both roll back).
    if (task.points > 0) {
      await tx.insert(pointsLedger).values({
        familyId: task.familyId,
        userId,
        delta: task.points,
        reason: 'task_completed',
        refId: completedRow.id,
      });
    }

    return completedRow;
  });
}

export function serializeOccurrence(row: OccurrenceWithTask) {
  return {
    id: row.id,
    taskId: row.taskId,
    scheduledDate: row.scheduledDate,
    scheduledTime: row.scheduledTime,
    assigneeId: row.assigneeId,
    status: row.status,
    subtasks: row.subtasks,
    completedAt: row.completedAt?.toISOString() ?? null,
    completedBy: row.completedBy,
    photoIds: row.photoIds,
    pointsAwarded: row.pointsAwarded,
    availableAt: row.availableAt?.toISOString() ?? null,
    task: {
      id: row.task.id,
      title: row.task.title,
      type: row.task.type,
      points: row.task.points,
      photoRequired: row.task.photoRequired,
      deadlineAt: row.task.deadlineAt?.toISOString() ?? null,
    },
  };
}

// re-export to keep service surface tight
export { inArray };
