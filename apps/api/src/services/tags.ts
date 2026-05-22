import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { tags, taskTags, type TagRow } from '../db/schema';

/**
 * Per-family tag service.
 *
 * Tags are scoped to a single family — there's no global pool. Name
 * uniqueness is enforced at the DB level (`tags_family_name_unique`,
 * case-insensitive); the service surfaces friendly errors so the route
 * can map to a 409 instead of leaking the constraint message.
 */
export class TagServiceError extends Error {
  constructor(public code: 'name_taken' | 'not_found') {
    super(code);
  }
}

export async function listTagsForFamily(familyId: string): Promise<TagRow[]> {
  return db
    .select()
    .from(tags)
    .where(eq(tags.familyId, familyId))
    .orderBy(tags.name);
}

export async function createTag(input: {
  familyId: string;
  name: string;
  color: string | null;
}): Promise<TagRow> {
  try {
    const [row] = await db
      .insert(tags)
      .values({
        familyId: input.familyId,
        name: input.name.trim(),
        color: input.color,
      })
      .returning();
    return row!;
  } catch (err) {
    // Drizzle wraps the underlying postgres error; the unique-violation
    // code (23505) is what we care about. Anything else bubbles up.
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === '23505'
    ) {
      throw new TagServiceError('name_taken');
    }
    throw err;
  }
}

export async function updateTag(input: {
  tagId: string;
  familyId: string;
  patch: { name?: string; color?: string | null };
}): Promise<TagRow | null> {
  const next: Partial<typeof tags.$inferInsert> = {};
  if (input.patch.name !== undefined) next.name = input.patch.name.trim();
  if (input.patch.color !== undefined) next.color = input.patch.color;
  if (Object.keys(next).length === 0) {
    const existing = await db.query.tags.findFirst({
      where: and(eq(tags.id, input.tagId), eq(tags.familyId, input.familyId)),
    });
    return existing ?? null;
  }
  try {
    const [row] = await db
      .update(tags)
      .set(next)
      .where(and(eq(tags.id, input.tagId), eq(tags.familyId, input.familyId)))
      .returning();
    return row ?? null;
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === '23505'
    ) {
      throw new TagServiceError('name_taken');
    }
    throw err;
  }
}

export async function deleteTag(input: {
  tagId: string;
  familyId: string;
}): Promise<boolean> {
  const res = await db
    .delete(tags)
    .where(and(eq(tags.id, input.tagId), eq(tags.familyId, input.familyId)))
    .returning({ id: tags.id });
  return res.length > 0;
}

/**
 * Replace the set of tags attached to a task. Caller is responsible for
 * having validated that the task belongs to the family; this helper
 * trusts the input and just rewrites the join rows. Pass an empty array
 * to clear all tags. We do this in two steps inside a transaction to
 * keep concurrent writes consistent.
 */
export async function setTaskTags(taskId: string, tagIds: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(taskTags).where(eq(taskTags.taskId, taskId));
    if (tagIds.length === 0) return;
    // De-dupe defensively — composite PK already guards but the insert
    // would error rather than no-op, and saving twice on a misclick
    // shouldn't 500.
    const unique = Array.from(new Set(tagIds));
    await tx
      .insert(taskTags)
      .values(unique.map((tagId) => ({ taskId, tagId })))
      .onConflictDoNothing();
  });
}

/**
 * Look up tag ids attached to a batch of tasks. Returns a map of
 * `taskId → tagId[]` so callers can fan it out onto the serialized
 * tasks/occurrences without N+1 queries. Missing task ids resolve
 * to an empty array.
 */
export async function getTagIdsForTasks(
  taskIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (taskIds.length === 0) return out;
  const rows = await db
    .select({ taskId: taskTags.taskId, tagId: taskTags.tagId })
    .from(taskTags)
    .where(inArray(taskTags.taskId, taskIds));
  for (const r of rows) {
    const arr = out.get(r.taskId);
    if (arr) arr.push(r.tagId);
    else out.set(r.taskId, [r.tagId]);
  }
  // Preserve a stable order so DTO output doesn't shuffle between
  // requests — sort by tag id (uuid string compare is fine here).
  for (const arr of out.values()) arr.sort();
  return out;
}

export function serializeTag(row: TagRow) {
  return {
    id: row.id,
    familyId: row.familyId,
    name: row.name,
    color: row.color,
    createdAt: row.createdAt.toISOString(),
  };
}

// Re-export the underlying drizzle helper here just so tests/routes
// don't need to import from the schema barrel directly.
export { tags, taskTags };
export type { TagRow };
// `sql` is used by callers that want to write raw count queries on
// the join table; expose it from the same module for convenience.
export { sql };
