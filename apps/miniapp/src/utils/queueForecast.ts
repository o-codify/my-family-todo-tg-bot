import type { OccurrenceDto, TaskDto } from '../api';

/**
 * Queue tasks are date-less in the DB — only one pending occurrence
 * exists at a time, anchored to whoever's turn it is. But conceptually
 * the task repeats on a cadence (cooldownDays, or daily if none).
 *
 * Previously this helper did a naive modular rotation through
 * `queueUserIds`, which DID NOT match the server's actual
 * pickNextAssignee (balance + last-completer aware). That mismatch
 * produced "him, me, me" in the calendar when the real rotation was
 * "him, me, him, me". Now we simulate the real algorithm step by
 * step: at every forecast tick we feed the running per-user
 * completion counts and last-picked user into the same picker logic
 * the server uses on actual completions.
 *
 * Inputs `completionsByTaskUser` + `lastCompleterByTask` +
 * `joinedAtByUser` come from the existing occurrences + member list
 * the caller already has.
 */
export function forecastQueueOccurrences(input: {
  tasks: TaskDto[];
  occurrences: OccurrenceDto[];
  /**
   * Fallback queue roster when `task.queueUserIds` is null. Mirrors the
   * server's behaviour: a queued task with no explicit roster rotates
   * through every family member. Pass all member ids.
   */
  memberIds: string[];
  /** Per (task, user) completion counts — derived from the same
   *  occurrences list passed to Calendar/Day, filtered to status='done'. */
  completionsByTaskUser: Map<string, number>;
  /** Per task latest completedBy user-id. Seeds the strict-alternation
   *  tie-break for the first forecast step. */
  lastCompleterByTask: Map<string, string | null>;
  /** Per user joinedAt for the deterministic deep tie-break. */
  joinedAtByUser: Map<string, Date>;
  todayIso: string;
  /** Inclusive upper bound — typically the end of the visible month. */
  toIso: string;
}): OccurrenceDto[] {
  const {
    tasks,
    occurrences,
    memberIds,
    completionsByTaskUser,
    lastCompleterByTask,
    joinedAtByUser,
    todayIso,
    toIso,
  } = input;
  const out: OccurrenceDto[] = [];

  const todayMs = isoToMs(todayIso);
  const toMs = isoToMs(toIso);
  if (toMs <= todayMs) return out;

  for (const task of tasks) {
    if (task.type !== 'queued') continue;
    if (task.archivedAt) continue;
    const queue =
      task.queueUserIds && task.queueUserIds.length > 0
        ? task.queueUserIds
        : memberIds;
    if (queue.length === 0) continue;

    const current = occurrences.find(
      (o) => o.taskId === task.id && o.status === 'pending',
    );
    if (!current) continue;

    const stepDays = task.cooldownDays && task.cooldownDays > 0 ? task.cooldownDays : 1;
    const stepMs = stepDays * 86_400_000;

    // Running per-user state.
    const sim = new Map<string, number>();
    for (const u of queue) {
      sim.set(u, completionsByTaskUser.get(`${task.id}:${u}`) ?? 0);
    }
    let lastCompleter: string | null =
      lastCompleterByTask.get(task.id) ?? null;
    // Treat the current pending row as already-completed-by-its-
    // assignee for forecasting purposes — the forecast covers the
    // turns AFTER the current one. Without this nudge, on a fresh
    // queue with zero completions the FIRST forecast step picks the
    // same user the current pending is on (because tie-break sees
    // everyone at zero), instead of properly alternating.
    if (current.assigneeId) {
      sim.set(current.assigneeId, (sim.get(current.assigneeId) ?? 0) + 1);
      lastCompleter = current.assigneeId;
    }
    // Explicit roster from the task drives the tie-break order — when
    // `queueUserIds` is null we fall back to memberIds (already used
    // as `queue` above) and the joinedAt secondary kicks in. Mirrors
    // the server's pickNextAssignee signature.
    const queueOrder = task.queueUserIds ?? null;

    // Anchor the forecast on the current pending's actual turn, not
    // on today. If the current row is on cooldown (availableAt in
    // the future), that's when it'll fire — byDate displays the dot
    // on that day. The NEXT rotation belongs `step` days after.
    // Without this, completing the chore yesterday would push the
    // next dot to today + step instead of yesterday + step, which is
    // the "счёт с сегодня, а не с последнего выполнения" regression
    // the user reported.
    const availableMs = current.availableAt
      ? new Date(current.availableAt).getTime()
      : todayMs;
    const anchorMs = Math.max(availableMs, todayMs);
    let cursor = anchorMs + stepMs;
    for (let i = 0; i < 365 && cursor <= toMs; i++) {
      const picked = pickNext(queue, sim, lastCompleter, joinedAtByUser, queueOrder);
      if (!picked) break;
      const iso = msToIso(cursor);
      out.push({
        ...current,
        id: `queue-forecast:${task.id}:${iso}`,
        scheduledDate: iso,
        assigneeId: picked,
        status: 'pending',
        // Reset per-occurrence fields that don't apply to a forecast.
        subtasks: null,
        completedAt: null,
        completedBy: null,
        photoIds: null,
        pointsAwarded: 0,
        availableAt: null,
      });
      sim.set(picked, (sim.get(picked) ?? 0) + 1);
      lastCompleter = picked;
      cursor += stepMs;
    }
  }

  return out;
}

/** Mirror of the server's pickNextAssignee — min-completions wins,
 *  ties exclude the last completer when there's another tied user,
 *  joinedAt as the deterministic deep tie-break. Kept inline here
 *  (rather than importing from the API) so the miniapp stays
 *  framework-only and doesn't pull a server module. */
function pickNext(
  queue: readonly string[],
  completions: Map<string, number>,
  lastCompleter: string | null,
  joinedAt: Map<string, Date>,
  queueOrder: readonly string[] | null,
): string | null {
  if (queue.length === 0) return null;
  const min = Math.min(...queue.map((u) => completions.get(u) ?? 0));
  const atMin = queue.filter((u) => (completions.get(u) ?? 0) === min);
  const eligible =
    lastCompleter && atMin.length > 1
      ? atMin.filter((u) => u !== lastCompleter)
      : atMin;
  // Build an order-index map. Users absent from queueOrder sort to
  // the back (Infinity) where the joinedAt tie-break still works.
  const orderIndex = new Map<string, number>();
  if (queueOrder) {
    queueOrder.forEach((uid, i) => orderIndex.set(uid, i));
  }
  const sorted = [...eligible].sort((a, b) => {
    const ia = orderIndex.get(a) ?? Infinity;
    const ib = orderIndex.get(b) ?? Infinity;
    if (ia !== ib) return ia - ib;
    const ja = joinedAt.get(a)?.getTime() ?? 0;
    const jb = joinedAt.get(b)?.getTime() ?? 0;
    return ja - jb;
  });
  return sorted[0] ?? null;
}

/** Distinguish a forecast row from a real one. */
export function isQueueForecast(occurrenceId: string): boolean {
  return occurrenceId.startsWith('queue-forecast:');
}

function isoToMs(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getTime();
}
function msToIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
