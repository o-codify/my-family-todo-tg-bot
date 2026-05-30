import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { db, type Db } from '../db/client';
import {
  auditLog,
  type AuditLogRow,
  type NewAuditLogRow,
} from '../db/schema';
import { logger } from '../logger';

export type DbLike = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Audit-log writer + reader.
 *
 * Writes are fire-and-forget from the caller's POV — a logging miss
 * must NEVER fail the originating mutation. `recordAuditEvent` swallows
 * any DB error and emits a logger warning instead.
 *
 * Reads back the latest events for a family, newest first. The History
 * page calls this alongside the existing occurrences + redemptions
 * queries and merges them into a single time-sorted feed.
 */

export type AuditEventKind =
  | 'task.create'
  | 'task.update'
  | 'task.delete'
  | 'task.restore';

/**
 * Diff two task rows and return the names of fields that materially
 * changed. Used by the History UI to render "Изменено: title, points"
 * without dumping a raw object diff in the user's face. Field names
 * are stable api-shape strings; the frontend maps them to localised
 * labels.
 *
 * We compare a curated set of meaningful fields — not the whole row —
 * so noisy bumps like `updatedAt` don't show up as "changes".
 */
type TaskLike = {
  title: string;
  description: string | null;
  type: string;
  schedule: unknown;
  assigneeId: string | null;
  queueUserIds: readonly string[] | null;
  participantIds: readonly string[] | null;
  deadlineAt: Date | null;
  points: number;
  photoRequired: boolean;
  requiresApproval: boolean;
  isQuest: boolean;
  singleShot: boolean;
  cooldownDays: number | null;
};

export function diffTaskFields(
  before: TaskLike,
  after: TaskLike,
): string[] {
  const changed: string[] = [];
  if (before.title !== after.title) changed.push('title');
  if ((before.description ?? '') !== (after.description ?? '')) changed.push('description');
  if (before.type !== after.type) changed.push('type');
  if (JSON.stringify(before.schedule) !== JSON.stringify(after.schedule)) {
    changed.push('schedule');
  }
  if (before.assigneeId !== after.assigneeId) changed.push('assigneeId');
  if (
    JSON.stringify(before.queueUserIds ?? null) !==
    JSON.stringify(after.queueUserIds ?? null)
  ) {
    changed.push('queueUserIds');
  }
  if (
    JSON.stringify(before.participantIds ?? null) !==
    JSON.stringify(after.participantIds ?? null)
  ) {
    changed.push('participantIds');
  }
  const beforeDeadline = before.deadlineAt?.getTime() ?? null;
  const afterDeadline = after.deadlineAt?.getTime() ?? null;
  if (beforeDeadline !== afterDeadline) changed.push('deadlineAt');
  if (before.points !== after.points) changed.push('points');
  if (before.photoRequired !== after.photoRequired) changed.push('photoRequired');
  if (before.requiresApproval !== after.requiresApproval) changed.push('requiresApproval');
  if (before.isQuest !== after.isQuest) changed.push('isQuest');
  if (before.singleShot !== after.singleShot) changed.push('singleShot');
  if (before.cooldownDays !== after.cooldownDays) changed.push('cooldownDays');
  return changed;
}

export function serializeAuditEvent(row: AuditLogRow) {
  return {
    id: row.id,
    familyId: row.familyId,
    actorUserId: row.actorUserId,
    kind: row.kind,
    entityType: row.entityType,
    entityId: row.entityId,
    entityTitle: row.entityTitle,
    details: row.details,
    createdAt: row.createdAt.toISOString(),
  };
}

export type RecordAuditEventInput = {
  familyId: string;
  actorUserId: string | null;
  kind: AuditEventKind | string;
  entityType: string;
  entityId: string;
  entityTitle?: string | null;
  details?: Record<string, unknown> | null;
};

export async function recordAuditEvent(
  input: RecordAuditEventInput,
  conn: DbLike = db,
): Promise<void> {
  const row: NewAuditLogRow = {
    familyId: input.familyId,
    actorUserId: input.actorUserId,
    kind: input.kind,
    entityType: input.entityType,
    entityId: input.entityId,
    entityTitle: input.entityTitle ?? null,
    details: input.details ?? null,
  };
  try {
    await conn.insert(auditLog).values(row);
  } catch (err) {
    // Audit failures must not block the caller's mutation — log and
    // keep going. Worst case we lose ONE row in the timeline.
    logger.warn({ err, kind: input.kind, entityId: input.entityId }, 'audit log insert failed');
  }
}

export async function listAuditEvents(input: {
  familyId: string;
  from?: Date;
  to?: Date;
  limit?: number;
}): Promise<AuditLogRow[]> {
  const conditions = [eq(auditLog.familyId, input.familyId)];
  if (input.from) conditions.push(gte(auditLog.createdAt, input.from));
  if (input.to) conditions.push(lte(auditLog.createdAt, input.to));
  return await db
    .select()
    .from(auditLog)
    .where(and(...conditions))
    .orderBy(desc(auditLog.createdAt))
    .limit(input.limit ?? 500);
}
