export type QueueCandidate = {
  userId: string;
  /** Number of times this user has completed the queued task. */
  completions: number;
  /** Membership join time, used as a deepest tie-breaker for
   *  deterministic ordering when neither an explicit queue order nor
   *  last-completer alternation can decide. */
  joinedAt: Date;
  /** True when `away_until > now()` — user is skipped for the round. */
  isAway: boolean;
};

export type QueueDecision =
  | { kind: 'assigned'; userId: string }
  | { kind: 'nobody_available' };

/**
 * Pick the next assignee for a queued task.
 *
 * Rule, in user's words: "если равное количество, то по очереди, а не
 * так что у нас по 1, я делал последний, и я снова" + "нужна
 * возможность установить дефолтный порядок в очереди, когда у всех
 * поровну выполнений, то чтобы шло по определенному порядку". So:
 *
 *   1. Filter out away-mode users.
 *   2. Take everyone tied at the minimum completion count.
 *   3. If `lastCompleterId` is one of them AND there's at least one
 *      other user at that same min — exclude them. That guarantees
 *      strict alternation when counts are equal.
 *   4. If only the last completer is at min (i.e. they're behind on
 *      completions), they stay picked — the balance rule wins. That
 *      keeps the "behind user catches up" semantics.
 *   5. Tie-break preference:
 *        a. position in `queueOrder` (the task's `queueUserIds`, in
 *           the order the user picked them when creating the task);
 *        b. `joinedAt` ascending — kept as a deterministic fallback
 *           for users not in `queueOrder` (e.g. when the task has no
 *           explicit roster and we're rotating through all family
 *           members).
 *
 * Returns `nobody_available` when all candidates are away.
 */
export function pickNextAssignee(
  candidates: readonly QueueCandidate[],
  lastCompleterId?: string | null,
  queueOrder?: readonly string[] | null,
): QueueDecision {
  const available = candidates.filter((c) => !c.isAway);
  if (available.length === 0) return { kind: 'nobody_available' };

  const minCompletions = Math.min(...available.map((c) => c.completions));
  const atMin = available.filter((c) => c.completions === minCompletions);
  // Exclude the last completer when there's someone else equally tied —
  // the rotation should go to them, not bounce back.
  const eligible =
    lastCompleterId && atMin.length > 1
      ? atMin.filter((c) => c.userId !== lastCompleterId)
      : atMin;

  // Build a position map from queueOrder. Users not in the list get
  // Infinity so they sort after every listed user; the joinedAt
  // fallback breaks the ensuing tie among them.
  const orderIndex = new Map<string, number>();
  if (queueOrder) {
    queueOrder.forEach((uid, i) => orderIndex.set(uid, i));
  }
  const sorted = [...eligible].sort((a, b) => {
    const ia = orderIndex.get(a.userId) ?? Infinity;
    const ib = orderIndex.get(b.userId) ?? Infinity;
    if (ia !== ib) return ia - ib;
    return a.joinedAt.getTime() - b.joinedAt.getTime();
  });
  return { kind: 'assigned', userId: sorted[0]!.userId };
}
