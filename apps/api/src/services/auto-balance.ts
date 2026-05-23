import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  familyMembers,
  taskOccurrences,
  tasks,
  users,
} from '../db/schema';

/**
 * Auto-balance: pick the family member with the lowest current load to
 * own a freshly-created task. Used by CreateTaskSheet's "Авто" option
 * so a parent dispatching a one-off chore doesn't have to mentally tally
 * who's been doing the most lately.
 *
 * Load metric — count of OPEN (pending / pending_approval) occurrences
 * assigned to the user across non-archived tasks in this family. Ties
 * broken by membership join time (deterministic + favours older members
 * who likely opted in first). Away-mode users are skipped — same rule
 * as the queued task rotation.
 *
 * Returns `null` when every member is away (caller should fall back to
 * leaving assignee blank rather than blocking the create).
 */
export async function pickAutoAssignee(input: {
  familyId: string;
  /** Optional excludeUserIds — used by callers that want to avoid the
   *  task creator (e.g. "assign to someone OTHER than me"). MVP doesn't
   *  use it but the helper accepts it for forward-compat. */
  excludeUserIds?: string[];
}): Promise<string | null> {
  const members = await db
    .select({
      userId: familyMembers.userId,
      joinedAt: familyMembers.joinedAt,
      awayUntil: users.awayUntil,
    })
    .from(familyMembers)
    .innerJoin(users, eq(familyMembers.userId, users.id))
    .where(eq(familyMembers.familyId, input.familyId));

  const now = new Date();
  const eligible = members.filter((m) => {
    if (input.excludeUserIds?.includes(m.userId)) return false;
    if (m.awayUntil && m.awayUntil > now) return false;
    return true;
  });
  if (eligible.length === 0) return null;

  // Count open occurrences per eligible user via a single grouped query.
  // pending_approval counts too — it's load that hasn't yet released the
  // user (parent might reject, so it could come back).
  const rows = await db
    .select({
      userId: taskOccurrences.assigneeId,
      cnt: sql<number>`COUNT(*)::int`,
    })
    .from(taskOccurrences)
    .innerJoin(tasks, eq(taskOccurrences.taskId, tasks.id))
    .where(
      and(
        eq(tasks.familyId, input.familyId),
        isNull(tasks.archivedAt),
        or(
          eq(taskOccurrences.status, 'pending'),
          eq(taskOccurrences.status, 'pending_approval'),
        ),
        inArray(
          taskOccurrences.assigneeId,
          eligible.map((m) => m.userId),
        ),
      ),
    )
    .groupBy(taskOccurrences.assigneeId);

  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.userId) counts.set(r.userId, r.cnt);
  }

  // Sort by (load asc, joinedAt asc) — deterministic across runs.
  const ranked = [...eligible].sort((a, b) => {
    const la = counts.get(a.userId) ?? 0;
    const lb = counts.get(b.userId) ?? 0;
    if (la !== lb) return la - lb;
    return a.joinedAt.getTime() - b.joinedAt.getTime();
  });

  return ranked[0]!.userId;
}
