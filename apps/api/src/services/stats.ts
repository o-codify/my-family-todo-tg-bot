import { and, desc, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import type { StatsPeriod, StatsResponse } from '@family-todo/shared';
import { db } from '../db/client';
import { familyMembers, taskOccurrences, tasks } from '../db/schema';

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Translate the period knob to an explicit [from, to] window. `all` is
 * capped at two years — long enough to compute streaks meaningfully but
 * short enough to avoid hauling every row a family ever completed.
 */
export function periodToRange(period: StatsPeriod, now: Date = new Date()): {
  from: string;
  to: string;
} {
  const to = now;
  let from: Date;
  switch (period) {
    case 'week':
      from = new Date(now.getTime() - 7 * DAY_MS);
      break;
    case 'month':
      from = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
      break;
    case 'all':
      from = new Date(now.getFullYear() - 2, now.getMonth(), now.getDate());
      break;
  }
  return { from: isoDate(from), to: isoDate(to) };
}

/**
 * Compute the full stats payload for one family + one period. Everything
 * happens in three queries:
 *   1. per-member completion count + points
 *   2. top tasks by completion count
 *   3. raw (userId, completedDate) tuples for streak computation
 *
 * The streak computation is the only piece that can't reasonably go in SQL
 * — we walk sorted dates in JS. Window functions could express it, but the
 * complexity isn't worth it at our volumes.
 */
export async function computeFamilyStats(input: {
  familyId: string;
  requestingUserId: string;
  period: StatsPeriod;
  now?: Date;
}): Promise<StatsResponse> {
  const now = input.now ?? new Date();
  const range = periodToRange(input.period, now);
  const fromTs = new Date(`${range.from}T00:00:00.000Z`);
  const toTs = new Date(`${range.to}T23:59:59.999Z`);

  // Filter occurrences scoped to family + done + in window. We anchor by
  // `completedAt` (not scheduledDate) so null-dated floating completions
  // show up too.
  const inWindow = and(
    eq(tasks.familyId, input.familyId),
    eq(taskOccurrences.status, 'done'),
    isNotNull(taskOccurrences.completedAt),
    gte(taskOccurrences.completedAt, fromTs),
    lte(taskOccurrences.completedAt, toTs),
  );

  // ── 1. byMember (count + points) ────────────────────────────────────
  const byMemberRows = await db
    .select({
      userId: taskOccurrences.completedBy,
      count: sql<number>`COUNT(*)::int`,
      pointsEarned: sql<number>`COALESCE(SUM(${taskOccurrences.pointsAwarded}), 0)::int`,
    })
    .from(taskOccurrences)
    .innerJoin(tasks, eq(taskOccurrences.taskId, tasks.id))
    .where(and(inWindow, isNotNull(taskOccurrences.completedBy)))
    .groupBy(taskOccurrences.completedBy);

  // Inflate with zero rows for members who haven't done anything in window —
  // the UI wants the full member list with bars at 0%.
  const members = await db
    .select({ userId: familyMembers.userId })
    .from(familyMembers)
    .where(eq(familyMembers.familyId, input.familyId));
  const byMemberMap = new Map<string, { count: number; pointsEarned: number }>();
  for (const m of members) byMemberMap.set(m.userId, { count: 0, pointsEarned: 0 });
  for (const r of byMemberRows) {
    if (!r.userId) continue;
    byMemberMap.set(r.userId, { count: r.count, pointsEarned: r.pointsEarned });
  }

  const byMember = Array.from(byMemberMap.entries())
    .map(([userId, v]) => ({ userId, count: v.count, pointsEarned: v.pointsEarned }))
    .sort((a, b) => b.count - a.count || b.pointsEarned - a.pointsEarned);

  const total = byMember.reduce((acc, x) => acc + x.count, 0);

  // ── 2. topTasks ─────────────────────────────────────────────────────
  const topTasksRows = await db
    .select({
      taskId: tasks.id,
      title: tasks.title,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(taskOccurrences)
    .innerJoin(tasks, eq(taskOccurrences.taskId, tasks.id))
    .where(inWindow)
    .groupBy(tasks.id, tasks.title)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(5);
  const topTasks = topTasksRows.map((r) => ({
    taskId: r.taskId,
    title: r.title,
    count: r.count,
  }));

  // ── 3. streaks — pull (userId, completedDate) for the window ─────────
  const streakRows = await db
    .select({
      userId: taskOccurrences.completedBy,
      // Anchor by completedAt's UTC date — same convention as the rest of the
      // app uses for done-anchoring (Calendar/Day filters).
      date: sql<string>`to_char(${taskOccurrences.completedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
    })
    .from(taskOccurrences)
    .innerJoin(tasks, eq(taskOccurrences.taskId, tasks.id))
    .where(and(inWindow, isNotNull(taskOccurrences.completedBy)));

  // Group dates per user, dedupe, sort.
  const datesByUser = new Map<string, Set<string>>();
  for (const r of streakRows) {
    if (!r.userId || !r.date) continue;
    let s = datesByUser.get(r.userId);
    if (!s) {
      s = new Set();
      datesByUser.set(r.userId, s);
    }
    s.add(r.date);
  }

  const meStreak = computeStreakForDates(datesByUser.get(input.requestingUserId), now);
  let familyBest: { userId: string | null; days: number } = { userId: null, days: 0 };
  for (const [userId, set] of datesByUser) {
    const s = computeStreakForDates(set, now);
    if (s.longest > familyBest.days) familyBest = { userId, days: s.longest };
  }

  // ── 4. unfairness ────────────────────────────────────────────────────
  const counts = byMember.map((x) => x.count);
  const positiveCounts = counts.filter((c) => c > 0);
  const minC = positiveCounts.length > 0 ? Math.min(...positiveCounts) : 0;
  const maxC = counts.length > 0 ? Math.max(...counts) : 0;
  const ratio = minC > 0 ? maxC / minC : 0;
  const topUserId = byMember[0] && byMember[0].count > 0 ? byMember[0].userId : null;
  const bottomCandidate = [...byMember].reverse().find((x) => x.count > 0);
  const bottomUserId = bottomCandidate ? bottomCandidate.userId : null;

  return {
    period: { kind: input.period, from: range.from, to: range.to },
    total,
    byMember,
    topTasks,
    streaks: {
      me: meStreak,
      familyBest,
    },
    unfairness: {
      ratio,
      topUserId,
      bottomUserId,
    },
  };
}

/**
 * Walk a deduped, sorted date set and return:
 *   - longest: max run of consecutive days
 *   - current: run that ends today or yesterday (else 0)
 *
 * Shared between the requesting-user computation and the family-best loop;
 * the algorithm matches the client-side version in Stats.tsx so we don't
 * surprise anyone with different numbers.
 */
export function computeStreakForDates(
  rawDates: Set<string> | undefined,
  now: Date = new Date(),
): { current: number; longest: number } {
  if (!rawDates || rawDates.size === 0) return { current: 0, longest: 0 };
  const sorted = Array.from(rawDates).sort();
  let longest = 1;
  let cur = 1;
  for (let i = 1; i < sorted.length; i++) {
    const diff = daysBetween(sorted[i - 1]!, sorted[i]!);
    if (diff === 1) {
      cur++;
      if (cur > longest) longest = cur;
    } else {
      cur = 1;
    }
  }
  // Current streak: anchored to today/yesterday.
  const today = isoDate(now);
  const yesterday = isoDate(new Date(now.getTime() - DAY_MS));
  const last = sorted[sorted.length - 1]!;
  let current = 0;
  if (last === today || last === yesterday) {
    current = 1;
    for (let i = sorted.length - 2; i >= 0; i--) {
      const diff = daysBetween(sorted[i]!, sorted[i + 1]!);
      if (diff === 1) current++;
      else break;
    }
  }
  return { current, longest };
}

function daysBetween(aIso: string, bIso: string): number {
  const a = new Date(`${aIso}T00:00:00.000Z`).getTime();
  const b = new Date(`${bIso}T00:00:00.000Z`).getTime();
  return Math.round((b - a) / DAY_MS);
}
