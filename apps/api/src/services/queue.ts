export type QueueCandidate = {
  userId: string;
  /** Number of times this user has completed the queued task. */
  completions: number;
  /** Membership join time, used as a tie-breaker for deterministic ordering. */
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
 * так что у нас по 1, я делал последний, и я снова". So:
 *
 *   1. Filter out away-mode users.
 *   2. Take everyone tied at the minimum completion count.
 *   3. If `lastCompleterId` is one of them AND there's at least one
 *      other user at that same min — exclude them. That guarantees
 *      strict alternation when counts are equal.
 *   4. If only the last completer is at min (i.e. they're behind on
 *      completions), they stay picked — the balance rule wins. That
 *      keeps the "behind user catches up" semantics.
 *   5. Among the remaining, joinedAt asc is the deterministic
 *      tie-breaker.
 *
 * Returns `nobody_available` when all candidates are away.
 */
export function pickNextAssignee(
  candidates: readonly QueueCandidate[],
  lastCompleterId?: string | null,
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

  const sorted = [...eligible].sort(
    (a, b) => a.joinedAt.getTime() - b.joinedAt.getTime(),
  );
  return { kind: 'assigned', userId: sorted[0]!.userId };
}
