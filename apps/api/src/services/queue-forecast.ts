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
import { pickNextAssignee } from './queue';

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
  /** Per-task completion counts at "now". Keyed by `${taskId}:${userId}`.
   *  Needed because the forecast simulates pickNextAssignee step by
   *  step (balance-aware) instead of doing a dumb modular rotation. */
  completionsByTaskUser: Map<string, number>;
  /** Per-task latest done.completedBy, to seed the strict-alternation
   *  tie-breaker for the first forecast step. */
  lastCompleterByTask: Map<string, string | null>;
  /** Per-user joinedAt for the deterministic joinedAt tie-break inside
   *  pickNextAssignee. Must cover every id referenced from
   *  `queueUserIds` / `memberIds`. */
  joinedAtByUser: Map<string, Date>;
  /** YYYY-MM-DD — the day forecasts start counting from. */
  todayIso: string;
  /** YYYY-MM-DD inclusive upper bound. */
  toIso: string;
}): QueueForecastRow[] {
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

    const stepDays =
      task.cooldownDays && task.cooldownDays > 0 ? task.cooldownDays : 1;
    const stepMs = stepDays * 86_400_000;

    // Per-step state. Mutated as we walk forward.
    const sim = new Map<string, number>();
    for (const u of queue) {
      sim.set(u, completionsByTaskUser.get(`${task.id}:${u}`) ?? 0);
    }
    let lastCompleter: string | null =
      lastCompleterByTask.get(task.id) ?? null;

    let cursor = todayMs + stepMs;
    // Defensive cap to avoid infinite loops if step somehow becomes 0.
    for (let i = 0; i < 365 && cursor <= toMs; i++) {
      const candidates = queue.map((userId) => ({
        userId,
        completions: sim.get(userId) ?? 0,
        // joinedAt is only used as the deepest tie-breaker; default to
        // 1970 if a queue member isn't in the family-members table.
        joinedAt: joinedAtByUser.get(userId) ?? new Date(0),
        // Away-mode isn't projected — we can't predict who'll be on
        // holiday weeks from now. Forecast is best-effort.
        isAway: false,
      }));
      const decision = pickNextAssignee(candidates, lastCompleter);
      if (decision.kind === 'nobody_available') break;
      const picked = decision.userId;
      const iso = msToIso(cursor);
      out.push({
        id: `queue-forecast:${task.id}:${iso}`,
        taskId: task.id,
        scheduledDate: iso,
        scheduledTime: current.scheduledTime ?? null,
        status: 'pending',
        assigneeId: picked,
        completedAt: null,
        completedBy: null,
      });
      sim.set(picked, (sim.get(picked) ?? 0) + 1);
      lastCompleter = picked;
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
