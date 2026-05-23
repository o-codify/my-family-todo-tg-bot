/**
 * Backend port of the miniapp's `utils/queueForecast.ts`. Queue tasks
 * are date-less in the DB — only one pending occurrence exists at any
 * time, anchored to whoever's current turn it is. The conceptual
 * cadence (round-robin through `queueUserIds`, stepping by `cooldownDays`
 * or 1 day) is reconstructed at read time on the client for the in-app
 * calendar. We mirror that logic here so the ICS feed shows the same
 * future rotations — without it, queue tasks would only appear once per
 * task, on today, even though the user expects to see "my turn" days
 * in their subscribed calendar.
 *
 * The forecast is a hint, not a contract — the server's actual rotation
 * on completion may differ (balance / away-aware logic). We accept that
 * drift because forecasts get replaced by real occurrences as time
 * advances. UID stability: each forecast carries
 * `queue-forecast:<taskId>:<iso>` so calendars treat the same future
 * day as the same event across refetches.
 */

import type { TaskRow, TaskOccurrenceRow } from '../db/schema';

export type QueueForecastRow = {
  /** Stable synthetic id — see file-level docstring. */
  id: string;
  taskId: string;
  scheduledDate: string;
  scheduledTime: string | null;
  status: 'pending';
  assigneeId: string | null;
  /** Completion fields are null on forecasts — these are pure predictions. */
  completedAt: null;
  completedBy: null;
};

export function forecastQueueOccurrences(input: {
  tasks: TaskRow[];
  occurrences: Pick<TaskOccurrenceRow, 'taskId' | 'status' | 'assigneeId' | 'scheduledTime'>[];
  /** Roster fallback when `task.queueUserIds` is null/empty. */
  memberIds: string[];
  /** YYYY-MM-DD — the day forecasts start counting from. */
  todayIso: string;
  /** YYYY-MM-DD inclusive upper bound. */
  toIso: string;
}): QueueForecastRow[] {
  const { tasks, occurrences, memberIds, todayIso, toIso } = input;
  const out: QueueForecastRow[] = [];

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

    const currentIdx = current.assigneeId ? queue.indexOf(current.assigneeId) : -1;
    const startIdx = currentIdx;

    const stepDays =
      task.cooldownDays && task.cooldownDays > 0 ? task.cooldownDays : 1;
    const stepMs = stepDays * 86_400_000;

    let cursor = todayMs + stepMs;
    let rotIdx = startIdx;
    // Defensive cap to avoid infinite loops if step somehow becomes 0.
    for (let i = 0; i < 365 && cursor <= toMs; i++) {
      rotIdx = (rotIdx + 1) % queue.length;
      const iso = msToIso(cursor);
      out.push({
        id: `queue-forecast:${task.id}:${iso}`,
        taskId: task.id,
        scheduledDate: iso,
        scheduledTime: current.scheduledTime ?? null,
        status: 'pending',
        assigneeId: queue[rotIdx] ?? null,
        completedAt: null,
        completedBy: null,
      });
      cursor += stepMs;
    }
  }

  return out;
}

function isoToMs(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getTime();
}
function msToIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
