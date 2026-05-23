import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { families } from './families';
import { users } from './users';

export const taskTypeEnum = pgEnum('task_type', ['oneoff', 'recurring', 'floating', 'queued']);
export const occurrenceStatusEnum = pgEnum('occurrence_status', [
  'pending',
  'done',
  'skipped',
  'expired',
  /** Completion submitted by a child but not yet approved by a parent.
   *  `completedAt` and `completedBy` are filled in; points are NOT yet
   *  awarded — that happens when an adult/owner flips the row to 'done'
   *  via /approve, or it reverts to 'pending' via /reject. */
  'pending_approval',
]);

export type TaskScheduleOneoff = { kind: 'oneoff'; date: string; time?: string };
export type TaskScheduleRecurring = {
  kind: 'recurring';
  recurrence: 'daily' | 'weekly' | 'interval';
  daysOfWeek?: number[]; // 0=Sun..6=Sat
  intervalDays?: number;
  time?: string;
};
export type TaskScheduleFloating = { kind: 'floating' };
export type TaskScheduleQueued = { kind: 'queued' };
export type TaskSchedule =
  | TaskScheduleOneoff
  | TaskScheduleRecurring
  | TaskScheduleFloating
  | TaskScheduleQueued;

export type SubtaskTemplateItem = { id: string; title: string; position: number };
export type SubtaskStateItem = SubtaskTemplateItem & { done: boolean };

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    type: taskTypeEnum('type').notNull(),
    schedule: jsonb('schedule').$type<TaskSchedule>().notNull(),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    queueUserIds: uuid('queue_user_ids').array(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }),
    points: integer('points').notNull().default(0),
    photoRequired: boolean('photo_required').notNull().default(false),
    /** When true, completions by Child-role members enter 'pending_approval'
     *  instead of going straight to 'done'. A parent (Adult/Owner role)
     *  then approves or rejects. Adult/owner completers skip the gate. */
    requiresApproval: boolean('requires_approval').notNull().default(false),
    singleShot: boolean('single_shot').notNull().default(false),
    cooldownDays: integer('cooldown_days'),
    subtasksTemplate: jsonb('subtasks_template').$type<SubtaskTemplateItem[]>(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyArchivedIdx: index('tasks_family_archived_idx').on(table.familyId, table.archivedAt),
    assigneeIdx: index('tasks_assignee_idx').on(table.assigneeId),
  }),
);

export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;

export const taskOccurrences = pgTable(
  'task_occurrences',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    scheduledDate: date('scheduled_date', { mode: 'string' }),
    scheduledTime: time('scheduled_time'),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    status: occurrenceStatusEnum('status').notNull().default('pending'),
    subtasks: jsonb('subtasks').$type<SubtaskStateItem[]>(),
    availableAt: timestamp('available_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedBy: uuid('completed_by').references(() => users.id, { onDelete: 'set null' }),
    photoIds: uuid('photo_ids').array(),
    pointsAwarded: integer('points_awarded').notNull().default(0),
    /** Set when an Adult/Owner approves a 'pending_approval' completion. */
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    /** Set when an Adult/Owner rejects a 'pending_approval' completion;
     *  the row also flips back to status='pending' so the kid can retry. */
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    rejectedBy: uuid('rejected_by').references(() => users.id, { onDelete: 'set null' }),
    rejectionReason: text('rejection_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // PostgreSQL treats NULL as distinct in unique indexes, so multiple rows with
    // (task_id, NULL) coexist — that's what we need for free-floating completions.
    // No WHERE clause means ON CONFLICT works without a predicate.
    taskDateUnique: uniqueIndex('occurrences_task_date_unique').on(
      table.taskId,
      table.scheduledDate,
    ),
    assigneeDateIdx: index('occurrences_assignee_date_idx').on(
      table.assigneeId,
      table.scheduledDate,
    ),
    taskStatusIdx: index('occurrences_task_status_idx').on(table.taskId, table.status),
  }),
);

export type TaskOccurrenceRow = typeof taskOccurrences.$inferSelect;
export type NewTaskOccurrenceRow = typeof taskOccurrences.$inferInsert;
