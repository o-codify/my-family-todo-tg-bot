import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  pointsLedger,
  rewardRedemptions,
  rewards,
  type RedemptionRow,
  type RewardRow,
} from '../db/schema';

export async function listRewards(familyId: string): Promise<RewardRow[]> {
  return db
    .select()
    .from(rewards)
    .where(and(eq(rewards.familyId, familyId), isNull(rewards.archivedAt)));
}

export async function getUserPoints(input: {
  familyId: string;
  userId: string;
}): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${pointsLedger.delta}), 0)::int`,
    })
    .from(pointsLedger)
    .where(
      and(eq(pointsLedger.familyId, input.familyId), eq(pointsLedger.userId, input.userId)),
    );
  return Number(row?.total ?? 0);
}

export async function awardPointsForCompletion(input: {
  familyId: string;
  userId: string;
  points: number;
  completionId: string;
}): Promise<void> {
  if (input.points <= 0) return;
  await db.insert(pointsLedger).values({
    familyId: input.familyId,
    userId: input.userId,
    delta: input.points,
    reason: 'task_completed',
    refId: input.completionId,
  });
}

export async function createReward(input: {
  familyId: string;
  createdBy: string;
  data: { name: string; emoji?: string | null; description?: string | null; costPoints: number };
}): Promise<RewardRow> {
  const [row] = await db
    .insert(rewards)
    .values({
      familyId: input.familyId,
      createdBy: input.createdBy,
      name: input.data.name.trim(),
      emoji: input.data.emoji ?? null,
      description: input.data.description ?? null,
      costPoints: input.data.costPoints,
    })
    .returning();
  return row!;
}

export async function archiveReward(input: {
  rewardId: string;
  familyId: string;
}): Promise<boolean> {
  const result = await db
    .update(rewards)
    .set({ archivedAt: new Date() })
    .where(and(eq(rewards.id, input.rewardId), eq(rewards.familyId, input.familyId)))
    .returning({ id: rewards.id });
  return result.length > 0;
}

export async function redeemReward(input: {
  rewardId: string;
  familyId: string;
  userId: string;
}): Promise<
  | { kind: 'requested'; redemption: RedemptionRow }
  | { kind: 'not_found' }
  | { kind: 'not_enough_points'; balance: number; needed: number }
> {
  return db.transaction(async (tx) => {
    const reward = await tx.query.rewards.findFirst({
      where: and(eq(rewards.id, input.rewardId), eq(rewards.familyId, input.familyId)),
    });
    if (!reward || reward.archivedAt) return { kind: 'not_found' as const };

    const [balanceRow] = await tx
      .select({ total: sql<number>`coalesce(sum(${pointsLedger.delta}), 0)::int` })
      .from(pointsLedger)
      .where(
        and(eq(pointsLedger.familyId, input.familyId), eq(pointsLedger.userId, input.userId)),
      );
    const balance = Number(balanceRow?.total ?? 0);
    if (balance < reward.costPoints) {
      return {
        kind: 'not_enough_points' as const,
        balance,
        needed: reward.costPoints - balance,
      };
    }

    const [redemption] = await tx
      .insert(rewardRedemptions)
      .values({
        rewardId: reward.id,
        familyId: input.familyId,
        userId: input.userId,
        costPoints: reward.costPoints,
        status: 'pending',
      })
      .returning();
    await tx.insert(pointsLedger).values({
      familyId: input.familyId,
      userId: input.userId,
      delta: -reward.costPoints,
      reason: 'reward_redeemed',
      refId: redemption!.id,
    });
    return { kind: 'requested' as const, redemption: redemption! };
  });
}

export async function listRedemptions(input: {
  familyId: string;
  userId?: string;
  status?: 'pending' | 'granted' | 'rejected';
}): Promise<RedemptionRow[]> {
  const conditions = [eq(rewardRedemptions.familyId, input.familyId)];
  if (input.userId) conditions.push(eq(rewardRedemptions.userId, input.userId));
  if (input.status) conditions.push(eq(rewardRedemptions.status, input.status));
  return db
    .select()
    .from(rewardRedemptions)
    .where(and(...conditions))
    .orderBy(desc(rewardRedemptions.requestedAt));
}

export async function grantRedemption(input: {
  redemptionId: string;
  familyId: string;
  grantedBy: string;
}): Promise<boolean> {
  const result = await db
    .update(rewardRedemptions)
    .set({ status: 'granted', grantedAt: new Date(), grantedBy: input.grantedBy })
    .where(
      and(
        eq(rewardRedemptions.id, input.redemptionId),
        eq(rewardRedemptions.familyId, input.familyId),
        eq(rewardRedemptions.status, 'pending'),
      ),
    )
    .returning({ id: rewardRedemptions.id });
  return result.length > 0;
}

export async function rejectRedemption(input: {
  redemptionId: string;
  familyId: string;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(rewardRedemptions)
      .set({ status: 'rejected', grantedAt: new Date() })
      .where(
        and(
          eq(rewardRedemptions.id, input.redemptionId),
          eq(rewardRedemptions.familyId, input.familyId),
          eq(rewardRedemptions.status, 'pending'),
        ),
      )
      .returning();
    if (!row) return false;
    // Refund points
    await tx.insert(pointsLedger).values({
      familyId: input.familyId,
      userId: row.userId,
      delta: row.costPoints,
      reason: 'manual_adjustment',
      refId: row.id,
    });
    return true;
  });
}

export function serializeReward(row: RewardRow) {
  return {
    id: row.id,
    familyId: row.familyId,
    name: row.name,
    emoji: row.emoji,
    description: row.description,
    costPoints: row.costPoints,
    availableForUserIds: row.availableForUserIds,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function serializeRedemption(row: RedemptionRow) {
  return {
    id: row.id,
    rewardId: row.rewardId,
    userId: row.userId,
    familyId: row.familyId,
    costPoints: row.costPoints,
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    grantedAt: row.grantedAt?.toISOString() ?? null,
    grantedBy: row.grantedBy,
  };
}
