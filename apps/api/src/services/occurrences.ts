import { and, eq, gte, isNull } from 'drizzle-orm';
import type { CreateTaskInput } from '@family-todo/shared';
import { db, type Db } from '../db/client';
import {
  taskOccurrences,
  type NewTaskOccurrenceRow,
  type SubtaskStateItem,
  type SubtaskTemplateItem,
  type TaskRow,
} from '../db/schema';

const OCCURRENCE_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// Drizzle's transaction callback receives an object with the same query surface
// as `db`. We accept that via a structural type to allow either at the call site.
export type DbLike = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function utcAtMidnight(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day));
}

function parseIsoDate(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return utcAtMidnight(y!, m! - 1, d!);
}

function subtasksFromTemplate(template: SubtaskTemplateItem[] | null): SubtaskStateItem[] | null {
  if (!template?.length) return null;
  return template.map((t) => ({ ...t, done: false }));
}

export function planOccurrencesForWindow(
  task: TaskRow,
  windowStart: Date = new Date(),
  windowDays: number = OCCURRENCE_WINDOW_DAYS,
): NewTaskOccurrenceRow[] {
  const startUtc = utcAtMidnight(
    windowStart.getUTCFullYear(),
    windowStart.getUTCMonth(),
    windowStart.getUTCDate(),
  );
  const windowEnd = new Date(startUtc.getTime() + windowDays * DAY_MS);
  const subtasksState = subtasksFromTemplate(task.subtasksTemplate ?? null);
  const time = (task.schedule as { time?: string }).time ?? null;

  const base = {
    taskId: task.id,
    assigneeId: task.assigneeId,
    status: 'pending' as const,
    subtasks: subtasksState,
    scheduledTime: time,
  };

  if (task.type === 'oneoff') {
    const sched = task.schedule as { kind: 'oneoff'; date: string };
    const target = parseIsoDate(sched.date);
    if (target.getTime() < startUtc.getTime() || target.getTime() >= windowEnd.getTime()) {
      return [];
    }
    return [{ ...base, scheduledDate: sched.date }];
  }

  if (task.type === 'recurring') {
    const sched = task.schedule as {
      kind: 'recurring';
      recurrence: 'daily' | 'weekly' | 'interval';
      daysOfWeek?: number[];
      intervalDays?: number;
    };

    const result: NewTaskOccurrenceRow[] = [];
    for (
      let d = new Date(startUtc);
      d.getTime() < windowEnd.getTime();
      d = new Date(d.getTime() + DAY_MS)
    ) {
      if (sched.recurrence === 'daily') {
        result.push({ ...base, scheduledDate: isoDate(d) });
      } else if (sched.recurrence === 'weekly') {
        const dow = d.getUTCDay();
        if (sched.daysOfWeek?.includes(dow)) {
          result.push({ ...base, scheduledDate: isoDate(d) });
        }
      } else if (sched.recurrence === 'interval' && sched.intervalDays) {
        const elapsed = Math.floor((d.getTime() - startUtc.getTime()) / DAY_MS);
        if (elapsed % sched.intervalDays === 0) {
          result.push({ ...base, scheduledDate: isoDate(d) });
        }
      }
    }
    return result;
  }

  return [];
}

export async function syncOccurrencesForTask(task: TaskRow, conn: DbLike = db): Promise<number> {
  const planned = planOccurrencesForWindow(task);
  if (!planned.length) return 0;

  const inserted = await conn
    .insert(taskOccurrences)
    .values(planned)
    .onConflictDoNothing({ target: [taskOccurrences.taskId, taskOccurrences.scheduledDate] })
    .returning({ id: taskOccurrences.id });
  return inserted.length;
}

export async function clearFutureOccurrences(taskId: string, conn: DbLike = db): Promise<void> {
  const today = isoDate(new Date());
  await conn
    .delete(taskOccurrences)
    .where(
      and(
        eq(taskOccurrences.taskId, taskId),
        eq(taskOccurrences.status, 'pending'),
        gte(taskOccurrences.scheduledDate, today),
      ),
    );
  await conn
    .delete(taskOccurrences)
    .where(
      and(
        eq(taskOccurrences.taskId, taskId),
        eq(taskOccurrences.status, 'pending'),
        isNull(taskOccurrences.scheduledDate),
      ),
    );
}

export function inputToSubtaskTemplate(
  input: CreateTaskInput['subtasks'],
): SubtaskTemplateItem[] | null {
  if (!input?.length) return null;
  return input.map((s, i) => ({ id: crypto.randomUUID(), title: s.title, position: i }));
}
