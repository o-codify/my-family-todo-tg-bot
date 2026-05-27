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
  // Latest completer of THIS task — fed into pickNextAssignee so an
  // equal-count tie alternates instead of sticking on the last actor.
  const [lastDone] = await conn
    .select({ completedBy: taskOccurrences.completedBy })
    .from(taskOccurrences)
    .where(
      and(
        eq(taskOccurrences.taskId, task.id),
        eq(taskOccurrences.status, 'done'),
      ),
    )
    .orderBy(desc(taskOccurrences.completedAt))
    .limit(1);
  const decision = pickNextAssignee(candidates, lastDone?.completedBy ?? null);
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
  // completion. Without this, completing a queue task with
  // cooldownDays=6 immediately puts the next pending on today's
  // anchor (byDate keys null-date pendings to today), and the user
  // sees the task they JUST finished pinned back on today.
  const availableAt =
    task.cooldownDays && task.cooldownDays > 0
      ? new Date(Date.now() + task.cooldownDays * 86_400_000)
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
