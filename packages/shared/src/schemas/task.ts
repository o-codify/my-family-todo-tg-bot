import { z } from 'zod';

export const taskTypeSchema = z.enum(['oneoff', 'recurring', 'floating', 'queued']);
export type TaskType = z.infer<typeof taskTypeSchema>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const isoTime = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'expected HH:MM or HH:MM:SS');

export const taskScheduleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('oneoff'),
    date: isoDate,
    time: isoTime.optional(),
  }),
  z.object({
    kind: z.literal('recurring'),
    recurrence: z.enum(['daily', 'weekly', 'interval']),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
    intervalDays: z.number().int().positive().optional(),
    time: isoTime.optional(),
  }),
  z.object({ kind: z.literal('floating') }),
  z.object({ kind: z.literal('queued') }),
]);

export type TaskScheduleInput = z.infer<typeof taskScheduleSchema>;

export const subtaskTemplateSchema = z
  .object({
    title: z.string().min(1).max(200),
  })
  .transform((v, ctx) => ({ ...v, _index: ctx.path }));

export const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  type: taskTypeSchema,
  schedule: taskScheduleSchema,
  assigneeId: z.string().uuid().nullable().optional(),
  queueUserIds: z.array(z.string().uuid()).nullable().optional(),
  deadlineAt: z.string().datetime().nullable().optional(),
  points: z.number().int().nonnegative().max(10_000).default(0),
  photoRequired: z.boolean().default(false),
  singleShot: z.boolean().default(false),
  cooldownDays: z.number().int().min(1).max(365).nullable().optional(),
  subtasks: z.array(z.object({ title: z.string().min(1).max(200) })).max(50).optional(),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = createTaskSchema.partial();
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const completeOccurrenceSchema = z.object({
  photoIds: z.array(z.string().uuid()).max(3).optional(),
  subtasksState: z.array(z.object({ id: z.string(), done: z.boolean() })).optional(),
});

export type CompleteOccurrenceInput = z.infer<typeof completeOccurrenceSchema>;

/**
 * Patch the done-state of one or more subtasks on a pending occurrence.
 * Lets a user tick subtasks off incrementally before the whole task is done.
 */
export const updateSubtasksStateSchema = z.object({
  patch: z.array(z.object({ id: z.string(), done: z.boolean() })).min(1),
});

export type UpdateSubtasksStateInput = z.infer<typeof updateSubtasksStateSchema>;

/**
 * Move a pending occurrence to a different date. The target date must not
 * conflict with another occurrence of the same task (the DB unique index
 * `(task_id, scheduled_date)` is enforced).
 */
export const rescheduleOccurrenceSchema = z.object({
  scheduledDate: isoDate,
});

export type RescheduleOccurrenceInput = z.infer<typeof rescheduleOccurrenceSchema>;

export const occurrencesQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  assignee: z.string().uuid().optional(),
});

export type OccurrencesQuery = z.infer<typeof occurrencesQuerySchema>;
