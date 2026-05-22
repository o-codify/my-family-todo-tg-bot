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
 * Picks the next assignee for a queued task using a balance-by-completions
 * strategy: minimum completions wins, ties broken by earliest joined_at.
 * Away-mode users are skipped entirely. Returns `nobody_available` when all
 * candidates are away.
 */
export function pickNextAssignee(candidates: readonly QueueCandidate[]): QueueDecision {
  const available = candidates.filter((c) => !c.isAway);
  if (available.length === 0) return { kind: 'nobody_available' };

  const sorted = [...available].sort((a, b) => {
    if (a.completions !== b.completions) return a.completions - b.completions;
    return a.joinedAt.getTime() - b.joinedAt.getTime();
  });
  return { kind: 'assigned', userId: sorted[0]!.userId };
}
