import { and, asc, eq, isNull } from 'drizzle-orm';
import type { CreateTaskCommentInput } from '@family-todo/shared';
import { db } from '../db/client';
import { taskComments, tasks, type TaskCommentRow } from '../db/schema';
import { publishFamilyEvent } from '../realtime/pubsub';

/**
 * Task comments service. Thin CRUD around `task_comments`. Only the
 * author can delete their own comment (soft-delete); we don't expose
 * an edit path — kids tend to fix typos with a follow-up, which keeps
 * the audit trail honest.
 *
 * Authorisation: the route handler verifies the task belongs to the
 * caller's family via `requireFamily`. Service trusts the input.
 */

export async function listComments(input: {
  taskId: string;
}): Promise<TaskCommentRow[]> {
  return db
    .select()
    .from(taskComments)
    .where(and(eq(taskComments.taskId, input.taskId), isNull(taskComments.deletedAt)))
    .orderBy(asc(taskComments.createdAt));
}

export async function createComment(input: {
  taskId: string;
  userId: string;
  data: CreateTaskCommentInput;
}): Promise<TaskCommentRow | null> {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, input.taskId),
  });
  if (!task) return null;
  const [row] = await db
    .insert(taskComments)
    .values({
      taskId: input.taskId,
      userId: input.userId,
      text: input.data.text,
    })
    .returning();
  void publishFamilyEvent(task.familyId, {
    kind: 'invalidate',
    scope: 'task-comments',
  });
  return row!;
}

/** Soft-delete a comment. Only the original author may delete. Returns
 *  true on success, false when the comment isn't owned (or doesn't
 *  exist / is already deleted). */
export async function deleteComment(input: {
  commentId: string;
  userId: string;
}): Promise<{ ok: boolean; familyId: string | null }> {
  const res = await db
    .update(taskComments)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(taskComments.id, input.commentId),
        eq(taskComments.userId, input.userId),
        isNull(taskComments.deletedAt),
      ),
    )
    .returning({ id: taskComments.id, taskId: taskComments.taskId });
  if (res.length === 0) return { ok: false, familyId: null };
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, res[0]!.taskId),
  });
  if (task) {
    void publishFamilyEvent(task.familyId, {
      kind: 'invalidate',
      scope: 'task-comments',
    });
  }
  return { ok: true, familyId: task?.familyId ?? null };
}

export function serializeTaskComment(row: TaskCommentRow) {
  return {
    id: row.id,
    taskId: row.taskId,
    userId: row.userId,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
  };
}
