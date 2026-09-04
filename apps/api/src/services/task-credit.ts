import type { TaskRow } from '../db/schema';

/**
 * Who gets credited for one completion of `task`.
 *
 * A shared task (non-empty `participantIds`) is done BY the family, not by
 * one person: the responsible assignee plus every listed participant all
 * count as having done it, and all earn the full points. A solo task
 * credits only whoever actually completed it.
 *
 * This is the single source of truth for both halves of "credit":
 *   - points  (points_ledger rows written on completion)
 *   - completions (the per-member counters on Stats / badges)
 *
 * They used to disagree: points already fanned out to every participant,
 * but the completion COUNT was grouped by `completed_by` alone, so on a
 * shared task only the one person who tapped "Выполнить" showed up in the
 * per-member totals. That is what put an artificial gap in the family
 * leaderboard ("задача должна считаться выполненной для всех, кто в ней").
 *
 * `assigneeId` is read from the TASK, not the occurrence: the occurrence's
 * assignee is rewritten to the completer on done, so it can no longer tell
 * us who was nominally responsible.
 */
export function completionCredits(
  task: Pick<TaskRow, 'participantIds' | 'assigneeId'>,
  completedBy: string,
): string[] {
  if (task.participantIds && task.participantIds.length > 0) {
    const base = task.assigneeId ?? completedBy;
    return [...new Set([base, ...task.participantIds, completedBy])];
  }
  return [completedBy];
}
