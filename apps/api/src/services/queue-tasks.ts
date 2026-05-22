import { and, eq, inArray, sql as dsql } from 'drizzle-orm';
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
  const decision = pickNextAssignee(candidates);
  if (decision.kind === 'nobody_available') return { error: 'nobody_available' };

  const existing = await conn
    .select()
    .from(taskOccurrences)
    .where(and(eq(taskOccurrences.taskId, task.id), eq(taskOccurrences.status, 'pending')))
    .limit(1);

  if (existing[0]) {
    if (existing[0].assigneeId !== decision.userId) {
      await conn
        .update(taskOccurrences)
        .set({ assigneeId: decision.userId })
        .where(eq(taskOccurrences.id, existing[0].id));
    }
    return { occurrenceId: existing[0].id, assigneeId: decision.userId };
  }

  const insertRow: NewTaskOccurrenceRow = {
    taskId: task.id,
    assigneeId: decision.userId,
    status: 'pending',
  };
  const [created] = await conn.insert(taskOccurrences).values(insertRow).returning();
  return { occurrenceId: created!.id, assigneeId: decision.userId };
}
