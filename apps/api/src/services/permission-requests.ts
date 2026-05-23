import { and, desc, eq } from 'drizzle-orm';
import type {
  CreatePermissionRequestInput,
  PermissionRequestStatus,
  PermissionRequestType,
} from '@family-todo/shared';
import { db } from '../db/client';
import {
  permissionRequests,
  type PermissionRequestRow,
} from '../db/schema';
import { publishFamilyEvent } from '../realtime/pubsub';

/**
 * Free-form permission requests — kid asks "Can I…?", parent says
 * yes/no. State machine:
 *   pending → approved | denied (decided by approver)
 *   pending → cancelled (by requester)
 *
 * No "modify after decide" — denied requests stay in history; the kid
 * creates a new one to ask again.
 */

export async function listRequests(input: {
  familyId: string;
  status?: PermissionRequestStatus;
  /** When set, only this user's requests are returned — useful for the
   *  kid-view page (their own history) without leaking siblings' asks. */
  requesterUserId?: string;
}): Promise<PermissionRequestRow[]> {
  const conditions = [eq(permissionRequests.familyId, input.familyId)];
  if (input.status) conditions.push(eq(permissionRequests.status, input.status));
  if (input.requesterUserId) {
    conditions.push(eq(permissionRequests.requesterUserId, input.requesterUserId));
  }
  return db
    .select()
    .from(permissionRequests)
    .where(and(...conditions))
    .orderBy(desc(permissionRequests.createdAt));
}

export async function createRequest(input: {
  familyId: string;
  userId: string;
  data: CreatePermissionRequestInput;
}): Promise<PermissionRequestRow> {
  const [row] = await db
    .insert(permissionRequests)
    .values({
      familyId: input.familyId,
      requesterUserId: input.userId,
      type: input.data.type,
      text: input.data.text,
    })
    .returning();
  void publishFamilyEvent(input.familyId, { kind: 'invalidate', scope: 'permission-requests' });
  return row!;
}

export async function decideRequest(input: {
  familyId: string;
  requestId: string;
  deciderUserId: string;
  decision: 'approved' | 'denied';
  reason?: string | null;
}): Promise<PermissionRequestRow | null> {
  // Only flip pending → terminal. Already-decided rows return as-is so
  // the UI behaves idempotently (double-tap is harmless).
  const [row] = await db
    .update(permissionRequests)
    .set({
      status: input.decision,
      decidedByUserId: input.deciderUserId,
      decidedAt: new Date(),
      decisionReason: input.reason?.trim() || null,
    })
    .where(
      and(
        eq(permissionRequests.id, input.requestId),
        eq(permissionRequests.status, 'pending'),
      ),
    )
    .returning();
  if (row) {
    void publishFamilyEvent(input.familyId, {
      kind: 'invalidate',
      scope: 'permission-requests',
    });
    return row;
  }
  // Fall through — fetch whatever's in the DB so the caller can decide
  // (route may return 200 with the unchanged row if it's already decided,
  // or 404 if it doesn't exist).
  const existing = await db.query.permissionRequests.findFirst({
    where: eq(permissionRequests.id, input.requestId),
  });
  return existing ?? null;
}

export async function cancelRequest(input: {
  familyId: string;
  requestId: string;
  userId: string;
}): Promise<PermissionRequestRow | null> {
  const [row] = await db
    .update(permissionRequests)
    .set({
      status: 'cancelled',
      decidedAt: new Date(),
    })
    .where(
      and(
        eq(permissionRequests.id, input.requestId),
        eq(permissionRequests.requesterUserId, input.userId),
        eq(permissionRequests.status, 'pending'),
      ),
    )
    .returning();
  if (row) {
    void publishFamilyEvent(input.familyId, {
      kind: 'invalidate',
      scope: 'permission-requests',
    });
  }
  return row ?? null;
}

export function serializePermissionRequest(row: PermissionRequestRow) {
  return {
    id: row.id,
    familyId: row.familyId,
    requesterUserId: row.requesterUserId,
    type: row.type as PermissionRequestType,
    text: row.text,
    status: row.status as PermissionRequestStatus,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionReason: row.decisionReason,
    createdAt: row.createdAt.toISOString(),
  };
}
