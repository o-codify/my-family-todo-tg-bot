import { and, desc, eq, lt, or } from 'drizzle-orm';
import { db } from '../db/client';
import {
  taskOccurrences,
  transferRequests,
  type TransferRequestRow,
  type TransferReward,
} from '../db/schema';

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

export async function createTransfer(input: {
  familyId: string;
  fromUserId: string;
  occurrenceId: string;
  toUserId: string;
  mode?: 'plain' | 'swap' | 'reward';
  message?: string | null;
  swapOccurrenceIds?: string[];
  rewards?: TransferReward[];
}): Promise<
  | { kind: 'created'; row: TransferRequestRow }
  | { kind: 'occurrence_not_found' }
  | { kind: 'already_pending' }
> {
  const occ = await db.query.taskOccurrences.findFirst({
    where: eq(taskOccurrences.id, input.occurrenceId),
  });
  if (!occ) return { kind: 'occurrence_not_found' };

  // Check no pending transfer already exists for this occurrence
  const existing = await db.query.transferRequests.findFirst({
    where: and(
      eq(transferRequests.occurrenceId, input.occurrenceId),
      eq(transferRequests.status, 'pending'),
    ),
  });
  if (existing) return { kind: 'already_pending' };

  const [row] = await db
    .insert(transferRequests)
    .values({
      familyId: input.familyId,
      fromUserId: input.fromUserId,
      toUserId: input.toUserId,
      occurrenceId: input.occurrenceId,
      mode: input.mode ?? 'plain',
      message: input.message ?? null,
      swapOccurrenceIds: input.swapOccurrenceIds ?? null,
      rewards: input.rewards ?? null,
      expiresAt: new Date(Date.now() + THREE_HOURS_MS),
    })
    .returning();
  return { kind: 'created', row: row! };
}

export async function acceptTransfer(input: {
  transferId: string;
  familyId: string;
  userId: string;
}): Promise<{ kind: 'accepted' } | { kind: 'not_found' } | { kind: 'not_recipient' } | { kind: 'expired' }> {
  return db.transaction(async (tx) => {
    const t = await tx.query.transferRequests.findFirst({
      where: and(
        eq(transferRequests.id, input.transferId),
        eq(transferRequests.familyId, input.familyId),
      ),
    });
    if (!t) return { kind: 'not_found' as const };
    if (t.toUserId !== input.userId) return { kind: 'not_recipient' as const };
    if (t.status !== 'pending') return { kind: 'not_found' as const };
    if (t.expiresAt.getTime() < Date.now()) {
      await tx
        .update(transferRequests)
        .set({ status: 'expired', resolvedAt: new Date() })
        .where(eq(transferRequests.id, t.id));
      return { kind: 'expired' as const };
    }
    await tx
      .update(taskOccurrences)
      .set({ assigneeId: input.userId })
      .where(eq(taskOccurrences.id, t.occurrenceId));
    if (t.mode === 'swap' && t.swapOccurrenceIds) {
      for (const occId of t.swapOccurrenceIds) {
        await tx
          .update(taskOccurrences)
          .set({ assigneeId: t.fromUserId })
          .where(eq(taskOccurrences.id, occId));
      }
    }
    await tx
      .update(transferRequests)
      .set({ status: 'accepted', resolvedAt: new Date() })
      .where(eq(transferRequests.id, t.id));
    return { kind: 'accepted' as const };
  });
}

export async function rejectTransfer(input: {
  transferId: string;
  familyId: string;
  userId: string;
}): Promise<{ kind: 'rejected' } | { kind: 'not_found' }> {
  const result = await db
    .update(transferRequests)
    .set({ status: 'rejected', resolvedAt: new Date() })
    .where(
      and(
        eq(transferRequests.id, input.transferId),
        eq(transferRequests.familyId, input.familyId),
        eq(transferRequests.toUserId, input.userId),
        eq(transferRequests.status, 'pending'),
      ),
    )
    .returning({ id: transferRequests.id });
  return result.length > 0 ? { kind: 'rejected' } : { kind: 'not_found' };
}

export async function cancelTransfer(input: {
  transferId: string;
  familyId: string;
  userId: string;
}): Promise<{ kind: 'cancelled' } | { kind: 'not_found' }> {
  const result = await db
    .update(transferRequests)
    .set({ status: 'cancelled', resolvedAt: new Date() })
    .where(
      and(
        eq(transferRequests.id, input.transferId),
        eq(transferRequests.familyId, input.familyId),
        eq(transferRequests.fromUserId, input.userId),
        eq(transferRequests.status, 'pending'),
      ),
    )
    .returning({ id: transferRequests.id });
  return result.length > 0 ? { kind: 'cancelled' } : { kind: 'not_found' };
}

export async function listMyIncomingTransfers(input: {
  familyId: string;
  userId: string;
}): Promise<TransferRequestRow[]> {
  // Mark expired ones in passing
  await db
    .update(transferRequests)
    .set({ status: 'expired', resolvedAt: new Date() })
    .where(
      and(
        eq(transferRequests.familyId, input.familyId),
        eq(transferRequests.status, 'pending'),
        lt(transferRequests.expiresAt, new Date()),
      ),
    );
  return db
    .select()
    .from(transferRequests)
    .where(
      and(
        eq(transferRequests.familyId, input.familyId),
        eq(transferRequests.toUserId, input.userId),
        eq(transferRequests.status, 'pending'),
      ),
    )
    .orderBy(desc(transferRequests.createdAt));
}

export async function listFeed(familyId: string): Promise<TransferRequestRow[]> {
  return db
    .select()
    .from(transferRequests)
    .where(
      and(
        eq(transferRequests.familyId, familyId),
        or(
          eq(transferRequests.status, 'accepted'),
          eq(transferRequests.status, 'rejected'),
          eq(transferRequests.status, 'expired'),
        )!,
      ),
    )
    .orderBy(desc(transferRequests.resolvedAt));
}

export function serializeTransfer(row: TransferRequestRow) {
  return {
    id: row.id,
    familyId: row.familyId,
    occurrenceId: row.occurrenceId,
    fromUserId: row.fromUserId,
    toUserId: row.toUserId,
    mode: row.mode,
    message: row.message,
    swapOccurrenceIds: row.swapOccurrenceIds,
    rewards: row.rewards,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
