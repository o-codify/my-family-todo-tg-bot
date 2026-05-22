import type { OccurrenceDto, TaskDto } from '../api';

/**
 * Queue tasks are date-less in the DB — only one pending occurrence
 * exists at a time, anchored to whoever's turn it is. But conceptually
 * the task repeats on a cadence (cooldownDays, or daily if none), with
 * the assignee rotating through `queueUserIds`.
 *
 * For the calendar/day UI the user wants to see those future rotations
 * — "Мусор на Zakir сегодня, на меня завтра, на Zakir послезавтра…".
 *
 * This helper generates *virtual* future occurrences for that view. They
 * carry a synthetic id (`queue-forecast:<taskId>:<iso>`) so they never
 * collide with real ids; clicking them is best left read-only (the real
 * pending row is what the backend ever knows about). The first virtual
 * row is at `today + step` — today itself is already covered by the real
 * pending occurrence which the caller anchors to today.
 *
 * Rotation: simple round-robin through `queueUserIds`, starting from
 * the slot after the current assignee. We don't try to mirror the
 * server's balance / away-aware algorithm — the forecast is a hint, not
 * a contract. When the server actually rotates on completion, the
 * forecast for the next day gets replaced by a real occurrence.
 */
export function forecastQueueOccurrences(input: {
  tasks: TaskDto[];
  occurrences: OccurrenceDto[];
  todayIso: string;
  /** Inclusive upper bound — typically the end of the visible month. */
  toIso: string;
}): OccurrenceDto[] {
  const { tasks, occurrences, todayIso, toIso } = input;
  const out: OccurrenceDto[] = [];

  const todayMs = isoToMs(todayIso);
  const toMs = isoToMs(toIso);
  if (toMs <= todayMs) return out;

  for (const task of tasks) {
    if (task.type !== 'queued') continue;
    if (task.archivedAt) continue;
    const queue = task.queueUserIds ?? [];
    if (queue.length === 0) continue;

    // The current real pending occurrence is anchored to today by the
    // caller (Calendar/Day). Use it as the rotation pivot.
    const current = occurrences.find(
      (o) => o.taskId === task.id && o.status === 'pending',
    );
    if (!current) continue;
    const currentIdx = current.assigneeId ? queue.indexOf(current.assigneeId) : -1;
    if (currentIdx === -1) continue;

    const stepDays = task.cooldownDays && task.cooldownDays > 0 ? task.cooldownDays : 1;
    const stepMs = stepDays * 86_400_000;

    let cursor = todayMs + stepMs;
    let rotIdx = currentIdx;
    // Cap iterations defensively (very long ranges + step=1 is fine; this
    // is just to avoid an infinite loop if step ever becomes 0).
    for (let i = 0; i < 365 && cursor <= toMs; i++) {
      rotIdx = (rotIdx + 1) % queue.length;
      const iso = msToIso(cursor);
      out.push({
        ...current,
        id: `queue-forecast:${task.id}:${iso}`,
        scheduledDate: iso,
        assigneeId: queue[rotIdx] ?? null,
        status: 'pending',
        // Reset per-occurrence fields that don't apply to a forecast.
        subtasks: null,
        completedAt: null,
        completedBy: null,
        photoIds: null,
        pointsAwarded: 0,
        availableAt: null,
      });
      cursor += stepMs;
    }
  }

  return out;
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
