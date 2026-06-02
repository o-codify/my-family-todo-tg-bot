import { and, desc, eq, inArray, sql as dsql } from 'drizzle-orm';
import { db, type Db } from '../db/client';
import {
  familyMembers,
  taskOccurrences,
  users,
  type TaskRow,
  type NewTaskOccurrenceRow,
} from '../db/schema';
import { pickNextAssignee, type QueueCandidate } from './queue';

/**
 * Batch-load full-history completion stats for a list of queue task
 * ids. The client used to derive these counts from its visible
 * occurrences window (42 days on Calendar, 180 days on QueueDetail),
 * which silently dropped older completions and made the per-user
 * balance read wrong. This helper goes straight to the source —
 * `task_occurrences where status='done'` — and returns the full
 * count + latest completer per task in two batched queries.
 *
 * The map is keyed by task id; tasks with zero completions aren't in
 * the map (caller defaults to empty when missing).
 */
export type QueueStatsRow = {
  completionsByUser: Record<string, number>;
  lastCompleterId: string | null;
  lastCompletedAt: Date | null;
};

export async function getQueueStatsForTasks(
  taskIds: string[],
): Promise<Map<string, QueueStatsRow>> {
  const out = new Map<string, QueueStatsRow>();
  if (taskIds.length === 0) return out;

  // 1. Per-(task, user) counts — single grouped query covers every
  //    task in the batch. Restrict to non-null completedBy so we
  //    don't bucket orphaned rows under "null user".
  const counts = await db
    .select({
      taskId: taskOccurrences.taskId,
      userId: taskOccurrences.completedBy,
      count: dsql<number>`count(*)::int`,
    })
    .from(taskOccurrences)
    .where(
      and(
        inArray(taskOccurrences.taskId, taskIds),
        eq(taskOccurrences.status, 'done'),
      ),
    )
    .groupBy(taskOccurrences.taskId, taskOccurrences.completedBy);

  for (const row of counts) {
    if (!row.userId) continue;
    const stats =
      out.get(row.taskId) ??
      ({
        completionsByUser: {},
        lastCompleterId: null,
        lastCompletedAt: null,
      } satisfies QueueStatsRow);
    stats.completionsByUser[row.userId] = Number(row.count);
    out.set(row.taskId, stats);
  }

  // 2. Latest done row per task — pull the full set and fold in JS
  //    (avoids a window-function for portability; queue completion
  //    volume per task is small).
  const lastRows = await db
    .select({
      taskId: taskOccurrences.taskId,
      completedBy: taskOccurrences.completedBy,
      completedAt: taskOccurrences.completedAt,
    })
    .from(taskOccurrences)
    .where(
      and(
        inArray(taskOccurrences.taskId, taskIds),
        eq(taskOccurrences.status, 'done'),
      ),
    );
  const latestAt = new Map<string, number>();
  for (const r of lastRows) {
    if (!r.completedAt) continue;
    const ts = r.completedAt.getTime();
    const prev = latestAt.get(r.taskId) ?? -Infinity;
    if (ts > prev) {
      latestAt.set(r.taskId, ts);
      const stats =
        out.get(r.taskId) ??
        ({
          completionsByUser: {},
          lastCompleterId: null,
          lastCompletedAt: null,
        } satisfies QueueStatsRow);
      stats.lastCompleterId = r.completedBy;
      stats.lastCompletedAt = r.completedAt;
      out.set(r.taskId, stats);
    }
  }

  return out;
}

export type DbLike = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Loads queue candidates for a task: each user listed in queue_user_ids
 * (or all family members if queue_user_ids is null), with their completion
 * count for THIS task and current away status.
 */
async function loadCandidates(task: TaskRow, conn: DbLike): Promise<QueueCandidate[]> {
  const userIds = task.queueUserIds?.length
    ? task.queueUserIds
    : (
        await conn
          .select({ userId: familyMembers.userId })
          .from(familyMembers)
          .where(eq(familyMembers.familyId, task.familyId))
      ).map((r) => r.userId);

  if (userIds.length === 0) return [];

  const memberRows = await conn
    .select({
      userId: familyMembers.userId,
      joinedAt: familyMembers.joinedAt,
      awayUntil: users.awayUntil,
    })
    .from(familyMembers)
    .innerJoin(users, eq(users.id, familyMembers.userId))
    .where(
      and(eq(familyMembers.familyId, task.familyId), inArray(familyMembers.userId, userIds)),
    );

  const completions = await conn
    .select({
      userId: taskOccurrences.completedBy,
      count: dsql<number>`count(*)::int`,
    })
    .from(taskOccurrences)
    .where(
      and(
        eq(taskOccurrences.taskId, task.id),
        eq(taskOccurrences.status, 'done'),
        inArray(
          taskOccurrences.completedBy,
          userIds as [string, ...string[]],
        ),
      ),
    )
    .groupBy(taskOccurrences.completedBy);

  const byUser = new Map(completions.map((c) => [c.userId, Number(c.count)]));
  const now = Date.now();

  return memberRows.map((m) => ({
    userId: m.userId,
    joinedAt: m.joinedAt,
    completions: byUser.get(m.userId) ?? 0,
    isAway: !!m.awayUntil && m.awayUntil.getTime() > now,
  }));
}

/**
 * Ensures there's a pending occurrence for a queued task with the next assignee
 * filled in. Returns the occurrence row (existing or newly created), or null
 * if all candidates are away.
 *
 * Idempotent: if a pending row already exists, only its assignee is updated.
 */
export async function ensureQueuedOccurrence(
  task: TaskRow,
  conn: DbLike = db,
): Promise<{ occurrenceId: string; assigneeId: string } | { error: 'nobody_available' }> {
  if (task.type !== 'queued') {
    throw new Error('ensureQueuedOccurrence called for non-queued task');
  }

  const candidates = await loadCandidates(task, conn);
  // Latest done occurrence — both its `completedBy` (so pickNextAssignee
  // can break a balance tie via strict alternation) and its
  // `completedAt` (so we can anchor the next cooldown to the actual
  // completion moment, not "now"). Without the timestamp anchor, the
  // ensure-spawned row's availableAt drifts forward every time
  // ensureQueuedOccurrence reruns after a delay (e.g. boot hydrate),
  // which the user reported as "кд считается с сегодняшнего дня, а не
  // с последнего выполнения".
  const [lastDone] = await conn
    .select({
      completedBy: taskOccurrences.completedBy,
      completedAt: taskOccurrences.completedAt,
    })
    .from(taskOccurrences)
    .where(
      and(
        eq(taskOccurrences.taskId, task.id),
        eq(taskOccurrences.status, 'done'),
      ),
    )
    .orderBy(desc(taskOccurrences.completedAt))
    .limit(1);
  const decision = pickNextAssignee(
    candidates,
    lastDone?.completedBy ?? null,
    task.queueUserIds ?? null,
  );
  if (decision.kind === 'nobody_available') return { error: 'nobody_available' };

  // The queue invariant is "at most one pending row per task". A bug
  // window in uncompleteOccurrence (now fixed) could leave duplicates
  // behind. Self-heal here: keep the oldest pending row, delete the
  // rest, and continue as if only that one existed.
  const existingAll = await conn
    .select()
    .from(taskOccurrences)
    .where(and(eq(taskOccurrences.taskId, task.id), eq(taskOccurrences.status, 'pending')))
    .orderBy(taskOccurrences.createdAt);

  if (existingAll.length > 1) {
    const stale = existingAll.slice(1).map((r) => r.id);
    await conn.delete(taskOccurrences).where(inArray(taskOccurrences.id, stale));
  }
  const existing = existingAll[0] ? [existingAll[0]] : [];

  if (existing[0]) {
    if (existing[0].assigneeId !== decision.userId) {
      await conn
        .update(taskOccurrences)
        .set({ assigneeId: decision.userId })
        .where(eq(taskOccurrences.id, existing[0].id));
    }
    return { occurrenceId: existing[0].id, assigneeId: decision.userId };
  }

  // Honour cooldown on the freshly-spawned row so the calendar grid
  // doesn't slap the next "Мусор" turn onto today right after a
  // completion.
  //
  // Anchor on the LATEST done.completedAt rather than `Date.now()`:
  //   - in the normal completeOccurrence flow they're basically the
  //     same instant, but
  //   - boot-time hydrate and other delayed retriggers run hours or
  //     days later, and `Date.now() + cooldownDays` would push the
  //     next turn forward by that gap — the regression the user just
  //     reported as "счёт с сегодняшнего дня".
  //   - a brand-new task with no completions yet has no anchor at
  //     all; leave availableAt null so the first turn is immediate.
  const availableAt =
    task.cooldownDays && task.cooldownDays > 0 && lastDone?.completedAt
      ? new Date(lastDone.completedAt.getTime() + task.cooldownDays * 86_400_000)
      : null;
  const insertRow: NewTaskOccurrenceRow = {
    taskId: task.id,
    assigneeId: decision.userId,
    status: 'pending',
    availableAt,
  };
  const [created] = await conn.insert(taskOccurrences).values(insertRow).returning();
  return { occurrenceId: created!.id, assigneeId: decision.userId };
}
