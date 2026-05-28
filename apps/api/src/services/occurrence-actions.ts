import { and, desc, eq, gte, inArray, isNull, lte, ne, or } from 'drizzle-orm';
import type { CompleteOccurrenceInput, OccurrencesQuery } from '@family-todo/shared';
import { db } from '../db/client';
import {
  familyMembers,
  pointsLedger,
  roles,
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
import { evaluateBadgesForUser } from './badges';

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
 *
 * Quest mode (`task.isQuest`) enforces sequential completion: a step
 * can only flip from `done=false` → `true` when every step before it
 * is already done. Out-of-order patches throw `out_of_order`. Unticking
 * (true → false) is always allowed so the user can undo a wrong tap.
 */
export async function patchOccurrenceSubtasks(input: {
  occurrence: OccurrenceWithTask;
  patch: NonNullable<CompleteOccurrenceInput['subtasksState']>;
}): Promise<TaskOccurrenceRow | null> {
  const current = input.occurrence.subtasks;
  if (!current) return null;

  if (input.occurrence.task.isQuest) {
    // Sort by position so "previous" actually means "earlier".
    const ordered = [...current].sort((a, b) => a.position - b.position);
    const byId = new Map(input.patch.map((p) => [p.id, p.done] as const));
    for (let i = 0; i < ordered.length; i++) {
      const step = ordered[i]!;
      const requested = byId.get(step.id);
      if (requested === true && !step.done) {
        // Trying to tick this step ON — every prior must already be done.
        const prior = ordered.slice(0, i);
        if (prior.some((p) => !p.done && byId.get(p.id) !== true)) {
          throw new OccurrenceActionError('out_of_order');
        }
      }
    }
  }

  const merged = mergeSubtasksState(current, input.patch);
  if (!merged) return null;
  const [updated] = await db
    .update(taskOccurrences)
    .set({ subtasks: merged })
    .where(eq(taskOccurrences.id, input.occurrence.id))
    .returning();
  return updated ?? null;
}

/**
 * Look up a user's permissions for a family. Returns null if the user is
 * not a member. Used by the approval gate inside completion paths so we
 * can decide whether to flip straight to 'done' or land in
 * 'pending_approval'. The middleware-level `requirePermission` covers
 * routes; this helper covers service-internal branching.
 */
async function getUserPermissionsForFamily(input: {
  familyId: string;
  userId: string;
}): Promise<string[] | null> {
  const row = await db
    .select({ permissions: roles.permissions })
    .from(familyMembers)
    .innerJoin(roles, eq(familyMembers.roleId, roles.id))
    .where(
      and(
        eq(familyMembers.familyId, input.familyId),
        eq(familyMembers.userId, input.userId),
      ),
    )
    .limit(1);
  return row[0]?.permissions ?? null;
}

/** True when the user is gated by approval for the given task — task has
 *  requiresApproval=true AND the user lacks the `task.approve` permission. */
async function shouldGateByApproval(input: {
  task: TaskRow;
  userId: string;
}): Promise<boolean> {
  if (!input.task.requiresApproval) return false;
  const perms = await getUserPermissionsForFamily({
    familyId: input.task.familyId,
    userId: input.userId,
  });
  if (perms === null) return false; // Stranger — middleware should have rejected.
  return !perms.includes('task.approve');
}

/**
 * Who earns points for a completion. For a shared task (has participantIds)
 * the points go to the responsible assignee plus every listed participant —
 * full points each. For a solo task it's just the completer. All ledger rows
 * are tagged with the occurrence id so uncomplete reverses them together.
 */
function pointsRecipients(task: TaskRow, completerId: string): string[] {
  if (task.participantIds && task.participantIds.length > 0) {
    const base = task.assigneeId ?? completerId;
    return [...new Set([base, ...task.participantIds])];
  }
  return [completerId];
}

export async function completeOccurrence(input: {
  occurrence: OccurrenceWithTask;
  userId: string;
  data: CompleteOccurrenceInput;
}): Promise<TaskOccurrenceRow> {
  const { occurrence, userId, data } = input;

  // Guard against re-completing an occurrence that's already been submitted.
  // Without this, a double POST /complete re-runs the points insert (the
  // ledger has no unique constraint on refId) and awards points twice.
  // A 'rejected' attempt flips back to 'pending', so retries still flow.
  if (occurrence.status === 'done' || occurrence.status === 'pending_approval') {
    throw new OccurrenceActionError('already_done');
  }

  if (occurrence.task.photoRequired && (!data.photoIds || data.photoIds.length === 0)) {
    throw new OccurrenceActionError('photo_required');
  }

  const subtasksState = mergeSubtasksState(occurrence.subtasks, data.subtasksState);
  const hasIncomplete = subtasksState?.some((s) => !s.done);
  if (hasIncomplete) {
    throw new OccurrenceActionError('subtasks_incomplete');
  }

  // Approval gate — when the task requires it AND the completer can't
  // self-approve, land in 'pending_approval' instead of 'done'. Points
  // and badges are deferred until a parent calls /approve. Subtasks
  // state + photos are still stored so the parent can see what was done.
  const gated = await shouldGateByApproval({ task: occurrence.task, userId });
  if (gated) {
    const [updated] = await db
      .update(taskOccurrences)
      .set({
        status: 'pending_approval',
        completedAt: new Date(),
        completedBy: userId,
        photoIds: data.photoIds ?? null,
        subtasks: subtasksState,
        // Clear any prior rejection from a previous attempt.
        rejectedAt: null,
        rejectedBy: null,
        rejectionReason: null,
      })
      .where(eq(taskOccurrences.id, occurrence.id))
      .returning();
    void publishFamilyEvent(occurrence.task.familyId, {
      kind: 'invalidate',
      scope: 'occurrences',
    });
    return updated!;
  }

  // Conditional on status to close the concurrent-complete race: if a
  // parallel request already flipped this row to 'done', the WHERE matches
  // nothing and we bail before awarding points a second time.
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
    .where(and(eq(taskOccurrences.id, occurrence.id), ne(taskOccurrences.status, 'done')))
    .returning();
  if (!updated) {
    throw new OccurrenceActionError('already_done');
  }

  // Award points for the completion — to every participant on a shared task,
  // to just the completer otherwise. Full points each.
  if (occurrence.task.points > 0) {
    for (const recipientId of pointsRecipients(occurrence.task, userId)) {
      await awardPointsForCompletion({
        familyId: occurrence.task.familyId,
        userId: recipientId,
        points: occurrence.task.points,
        completionId: updated!.id,
      });
    }
  }

  // For queued tasks: spawn the next round with the next assignee.
  if (occurrence.task.type === 'queued') {
    await ensureQueuedOccurrence(occurrence.task);
  }

  // Reminder is moot once the task is done. Best-effort cancel.
  void cancelReminderForOccurrence(occurrence.id).catch((err) =>
    logger.warn({ err, occurrenceId: occurrence.id }, 'cancel reminder on complete failed'),
  );
  // Re-evaluate badges inline — completion may unlock one. We wait
  // before returning so the response carries any freshly-earned slugs
  // (and integration tests can rely on badges being settled before
  // they tear down test data — async eval otherwise races TRUNCATE
  // CASCADE with FK violations and lock deadlocks). The catch makes
  // a badge-aggregation hiccup a logged warning, not a failed request.
  try {
    await evaluateBadgesForUser({ familyId: occurrence.task.familyId, userId });
  } catch (err) {
    logger.warn({ err, userId, familyId: occurrence.task.familyId }, 'evaluateBadges failed');
  }
  void publishFamilyEvent(occurrence.task.familyId, { kind: 'invalidate', scope: 'occurrences' });

  return updated!;
}

export async function uncompleteOccurrence(
  occurrenceId: string,
): Promise<TaskOccurrenceRow | null> {
  // Queue tasks: when completeOccurrence ran, it spawned a successor
  // pending row via ensureQueuedOccurrence (next rotation slot). Just
  // flipping THIS row back to 'pending' without touching the successor
  // would leave two pending rows for the same task — and each subsequent
  // complete→uncomplete cycle would pile on another duplicate. Wrap in
  // a transaction so the "delete siblings + flip back" pair is atomic.
  return await db.transaction(async (tx) => {
    const existing = await tx.query.taskOccurrences.findFirst({
      where: eq(taskOccurrences.id, occurrenceId),
    });
    if (!existing) return null;

    const task = await tx.query.tasks.findFirst({
      where: eq(tasks.id, existing.taskId),
    });
    if (task?.type === 'queued') {
      // The queue-task invariant is "≤ 1 pending row at a time". Delete
      // any pending siblings (the spawned successor, plus any historic
      // duplicates from earlier complete→uncomplete cycles before this
      // fix landed — this self-heals corrupt state).
      await tx
        .delete(taskOccurrences)
        .where(
          and(
            eq(taskOccurrences.taskId, existing.taskId),
            eq(taskOccurrences.status, 'pending'),
            ne(taskOccurrences.id, occurrenceId),
          ),
        );
    }

    // Reverse the points that completeOccurrence awarded. Without this
    // step the user keeps the points on their balance even though the
    // task is no longer marked done. User report: "Отменил выполнение
    // задач, за которые получил баллы, а их обратно не сняло."
    //
    // Strategy: delete the ledger rows tagged with this occurrence's id
    // (reason='task_completed', refId=occurrenceId). The ledger is an
    // append-only log in spirit, but DELETE here keeps the running sum
    // correct without needing a new enum value or a compensating row
    // that complicates the history view. The companion completeOccurrence
    // path will re-insert if the task gets re-completed.
    await tx
      .delete(pointsLedger)
      .where(
        and(
          eq(pointsLedger.reason, 'task_completed'),
          eq(pointsLedger.refId, occurrenceId),
        ),
      );

    const [updated] = await tx
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

    if (updated) {
      // Re-schedule the reminder if the occurrence is still in the future.
      // The helper handles all the "is it eligible?" checks.
      void scheduleReminderForOccurrence(updated.id).catch((err) =>
        logger.warn({ err, occurrenceId }, 'reschedule reminder on uncomplete failed'),
      );
      if (task) {
        void publishFamilyEvent(task.familyId, {
          kind: 'invalidate',
          scope: 'occurrences',
        });
      }
    }
    return updated ?? null;
  });
}

export class OccurrenceActionError extends Error {
  constructor(
    public readonly code:
      | 'photo_required'
      | 'subtasks_incomplete'
      | 'wrong_task_type'
      | 'task_archived'
      | 'already_done'
      | 'date_conflict'
      | 'wrong_status'
      | 'out_of_order',
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

  // Approval gate — same rule as the dated path. When gated, we land the
  // completion in 'pending_approval' WITHOUT awarding points, scheduling
  // the next pending occurrence, or archiving on single-shot. Those
  // deferred steps run when a parent approves.
  const gated = await shouldGateByApproval({ task, userId });

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

    // Gated short-circuit: write a pending_approval row and bail out.
    // We deliberately do NOT touch single_shot archive / wait_then_reopen
    // / points / queue — all deferred to the approve step.
    if (gated) {
      let row: TaskOccurrenceRow;
      if (pending[0]) {
        const [updated] = await tx
          .update(taskOccurrences)
          .set({
            status: 'pending_approval',
            completedAt: today,
            completedBy: userId,
            photoIds: data.photoIds ?? null,
            rejectedAt: null,
            rejectedBy: null,
            rejectionReason: null,
          })
          .where(eq(taskOccurrences.id, pending[0].id))
          .returning();
        row = updated!;
      } else {
        const [inserted] = await tx
          .insert(taskOccurrences)
          .values({
            taskId: task.id,
            status: 'pending_approval',
            completedAt: today,
            completedBy: userId,
            photoIds: data.photoIds ?? null,
          })
          .returning();
        row = inserted!;
      }
      return row;
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
          // Backfill the assignee if the existing pending row was
          // missing one — happens for legacy rows created before this
          // fix landed. Without this, the done row leaks into other
          // members' ICS feeds via the `assigneeId IS NULL` branch.
          assigneeId: pending[0].assigneeId ?? task.assigneeId ?? userId,
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
          // Inherit the task's assignee; for shared tasks (task.
          // assigneeId is null) fall back to the completer so the
          // row still has an owner and doesn't appear in everybody
          // else's per-user ICS feed.
          assigneeId: task.assigneeId ?? userId,
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
      // Inherit task.assigneeId on the reopened row — see the comment
      // above. Without this, the next pending sits in the DB with
      // assigneeId=NULL and leaks into every member's ICS feed.
      await tx.insert(taskOccurrences).values({
        taskId: task.id,
        status: 'pending',
        availableAt: decision.availableAt,
        assigneeId: task.assigneeId ?? null,
      });
    } else {
      // reopen_immediately
      await tx.insert(taskOccurrences).values({
        taskId: task.id,
        status: 'pending',
        assigneeId: task.assigneeId ?? null,
      });
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
  }).then(async (row) => {
    // Re-evaluate badges after the tx commits — completion may unlock one.
    // Same inline-await pattern as the regular completion path; keeps
    // tests deterministic and a follow-up read after complete includes
    // freshly-awarded slugs.
    try {
      await evaluateBadgesForUser({ familyId: task.familyId, userId });
    } catch (err) {
      logger.warn(
        { err, userId, familyId: task.familyId },
        'evaluateBadges (floating) failed',
      );
    }
    return row;
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
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedBy: row.approvedBy,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    rejectedBy: row.rejectedBy,
    rejectionReason: row.rejectionReason,
    task: {
      id: row.task.id,
      title: row.task.title,
      type: row.task.type,
      points: row.task.points,
      photoRequired: row.task.photoRequired,
      requiresApproval: row.task.requiresApproval,
      isQuest: row.task.isQuest,
      participantIds: row.task.participantIds,
      deadlineAt: row.task.deadlineAt?.toISOString() ?? null,
    },
  };
}

/**
 * Approve a 'pending_approval' completion — runs the deferred parts of
 * `completeOccurrence` (flip to 'done', award points, spawn queued next,
 * evaluate badges). Caller MUST have the `task.approve` permission;
 * route handler enforces.
 *
 * Idempotent for already-done rows (returns them as-is). Throws
 * `wrong_status` if the row was never submitted for approval.
 */
export async function approveOccurrence(input: {
  occurrenceId: string;
  approverId: string;
}): Promise<TaskOccurrenceRow | null> {
  const existing = await db
    .select()
    .from(taskOccurrences)
    .innerJoin(tasks, eq(taskOccurrences.taskId, tasks.id))
    .where(eq(taskOccurrences.id, input.occurrenceId))
    .limit(1);
  const row = existing[0];
  if (!row) return null;
  const { task_occurrences: occ, tasks: task } = row;

  if (occ.status === 'done') return occ; // already approved
  if (occ.status !== 'pending_approval') {
    throw new OccurrenceActionError('wrong_status');
  }

  const completerId = occ.completedBy ?? input.approverId;
  const [updated] = await db
    .update(taskOccurrences)
    .set({
      status: 'done',
      approvedAt: new Date(),
      approvedBy: input.approverId,
      pointsAwarded: task.points,
    })
    .where(eq(taskOccurrences.id, input.occurrenceId))
    .returning();

  if (task.points > 0) {
    for (const recipientId of pointsRecipients(task, completerId)) {
      await awardPointsForCompletion({
        familyId: task.familyId,
        userId: recipientId,
        points: task.points,
        completionId: updated!.id,
      });
    }
  }
  if (task.type === 'queued') {
    await ensureQueuedOccurrence(task);
  }
  if (task.type === 'floating') {
    // The gated floating completion deferred archive / wait_then_reopen /
    // reopen_immediately to approval time. Run it now so the task carries
    // on its normal lifecycle.
    const decision = decideAfterFloatingCompletion({
      singleShot: task.singleShot,
      cooldownDays: task.cooldownDays,
      completedAt: new Date(),
    });
    if (decision.kind === 'archive') {
      await db
        .update(tasks)
        .set({ archivedAt: new Date() })
        .where(eq(tasks.id, task.id));
    } else if (decision.kind === 'wait_then_reopen') {
      await db.insert(taskOccurrences).values({
        taskId: task.id,
        status: 'pending',
        availableAt: decision.availableAt,
      });
    } else {
      await db.insert(taskOccurrences).values({ taskId: task.id, status: 'pending' });
    }
  }
  void cancelReminderForOccurrence(occ.id).catch((err) =>
    logger.warn({ err, occurrenceId: occ.id }, 'cancel reminder on approve failed'),
  );
  try {
    await evaluateBadgesForUser({ familyId: task.familyId, userId: completerId });
  } catch (err) {
    logger.warn(
      { err, userId: completerId, familyId: task.familyId },
      'evaluateBadges (approve) failed',
    );
  }
  void publishFamilyEvent(task.familyId, { kind: 'invalidate', scope: 'occurrences' });
  return updated!;
}

/**
 * Reject a 'pending_approval' completion. Flips the row back to
 * 'pending' so the kid can retry; stores the reason + rejecter for the
 * UI. Clears completion/photo/subtasks state so the row is "fresh" again
 * (kid often needs to redo work, not just re-submit the same evidence).
 */
export async function rejectOccurrence(input: {
  occurrenceId: string;
  rejecterId: string;
  reason?: string | null;
}): Promise<TaskOccurrenceRow | null> {
  const existing = await db.query.taskOccurrences.findFirst({
    where: eq(taskOccurrences.id, input.occurrenceId),
  });
  if (!existing) return null;
  if (existing.status !== 'pending_approval') {
    throw new OccurrenceActionError('wrong_status');
  }
  const [updated] = await db
    .update(taskOccurrences)
    .set({
      status: 'pending',
      completedAt: null,
      completedBy: null,
      photoIds: null,
      rejectedAt: new Date(),
      rejectedBy: input.rejecterId,
      rejectionReason: input.reason?.trim() || null,
    })
    .where(eq(taskOccurrences.id, input.occurrenceId))
    .returning();
  if (updated) {
    // Re-schedule the reminder — the kid still has to do this. Best-effort.
    void scheduleReminderForOccurrence(updated.id).catch((err) =>
      logger.warn(
        { err, occurrenceId: updated.id },
        'reschedule reminder on reject failed',
      ),
    );
    const t = await db.query.tasks.findFirst({ where: eq(tasks.id, updated.taskId) });
    if (t)
      void publishFamilyEvent(t.familyId, { kind: 'invalidate', scope: 'occurrences' });
  }
  return updated ?? null;
}

/**
 * Bulk-complete a list of occurrences. Iterates and calls the regular
 * `completeOccurrence` per id so each goes through the standard rules
 * (photo gate, subtasks gate, approval gate, queue spawn, badges).
 * Returns a per-id result so the UI can render mixed outcomes ("3
 * completed, 1 needs a photo").
 *
 * Failures don't abort the loop — one bad id shouldn't block the rest
 * from going through. Each row is fetched independently because the
 * inputs span families/tasks; we re-check `familyId` per id to keep
 * the auth boundary tight.
 */
export type BulkCompleteResult = {
  occurrenceId: string;
  status: 'done' | 'pending_approval' | 'error';
  error?: string;
};

export async function bulkCompleteOccurrences(input: {
  familyId: string;
  userId: string;
  occurrenceIds: string[];
}): Promise<BulkCompleteResult[]> {
  const out: BulkCompleteResult[] = [];
  for (const id of input.occurrenceIds) {
    const occ = await getOccurrenceInFamily(id, input.familyId);
    if (!occ) {
      out.push({ occurrenceId: id, status: 'error', error: 'not_found' });
      continue;
    }
    // Same ownership rule as the single /complete route: you can only close
    // your own task or an unassigned shared one. Calling completeOccurrence
    // directly would otherwise let anyone complete (and self-award points
    // for) another member's task via the bulk endpoint.
    const canAct = occ.assigneeId === null || occ.assigneeId === input.userId;
    if (!canAct) {
      out.push({ occurrenceId: id, status: 'error', error: 'not_your_task' });
      continue;
    }
    try {
      const updated = await completeOccurrence({
        occurrence: occ,
        userId: input.userId,
        data: {},
      });
      out.push({
        occurrenceId: id,
        status: updated.status === 'pending_approval' ? 'pending_approval' : 'done',
      });
    } catch (err) {
      if (err instanceof OccurrenceActionError) {
        out.push({ occurrenceId: id, status: 'error', error: err.code });
      } else {
        out.push({ occurrenceId: id, status: 'error', error: 'internal' });
      }
    }
  }
  return out;
}

/**
 * List all 'pending_approval' occurrences across the family, newest
 * first. Used by the Inbox "Awaiting approval" section visible to
 * users with the `task.approve` permission.
 */
export async function listPendingApprovals(
  familyId: string,
): Promise<OccurrenceWithTask[]> {
  const rows = await db
    .select()
    .from(taskOccurrences)
    .innerJoin(tasks, eq(taskOccurrences.taskId, tasks.id))
    .where(
      and(
        eq(tasks.familyId, familyId),
        isNull(tasks.archivedAt),
        eq(taskOccurrences.status, 'pending_approval'),
      ),
    )
    .orderBy(desc(taskOccurrences.completedAt));
  return rows.map((r) => ({ ...r.task_occurrences, task: r.tasks }));
}

// re-export to keep service surface tight
export { inArray };
