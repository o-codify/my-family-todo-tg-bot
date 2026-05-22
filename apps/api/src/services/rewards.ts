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

/** Joined view used by listRedemptions — carries the reward's name/emoji
 *  alongside the redemption row so the Inbox / Magazin doesn't have to do
 *  a separate `listRewards` call just to render "Хочет приз X". The reward
 *  may have been archived (rewardId is nullable), in which case both
 *  fields are null and the UI falls back to the cost. */
export type RedemptionWithReward = RedemptionRow & {
  rewardName: string | null;
  rewardEmoji: string | null;
};

export async function listRedemptions(input: {
  familyId: string;
  userId?: string;
  status?: 'pending' | 'granted' | 'rejected';
}): Promise<RedemptionWithReward[]> {
  const conditions = [eq(rewardRedemptions.familyId, input.familyId)];
  if (input.userId) conditions.push(eq(rewardRedemptions.userId, input.userId));
  if (input.status) conditions.push(eq(rewardRedemptions.status, input.status));
  // LEFT JOIN because `rewardId` is nullable — a redemption can outlive
  // the reward it referenced (admin deleted/archived the reward later).
  const rows = await db
    .select({ redemption: rewardRedemptions, reward: rewards })
    .from(rewardRedemptions)
    .leftJoin(rewards, eq(rewardRedemptions.rewardId, rewards.id))
    .where(and(...conditions))
    .orderBy(desc(rewardRedemptions.requestedAt));
  return rows.map((r) => ({
    ...r.redemption,
    rewardName: r.reward?.name ?? null,
    rewardEmoji: r.reward?.emoji ?? null,
  }));
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

export function serializeRedemption(row: RedemptionRow | RedemptionWithReward) {
  // `RedemptionWithReward` carries the join'd reward name/emoji — for
  // single-row helpers (`requestRedemption` returns just the row) those
  // fields are absent and we emit null.
  const withReward = row as Partial<RedemptionWithReward>;
  return {
    id: row.id,
    rewardId: row.rewardId,
    rewardName: withReward.rewardName ?? null,
    rewardEmoji: withReward.rewardEmoji ?? null,
    userId: row.userId,
    familyId: row.familyId,
    costPoints: row.costPoints,
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    grantedAt: row.grantedAt?.toISOString() ?? null,
    grantedBy: row.grantedBy,
  };
}
