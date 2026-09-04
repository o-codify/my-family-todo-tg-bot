import { and, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  taskOccurrences,
  taskPhotos,
  tasks,
  userBadges,
  type UserBadgeRow,
} from '../db/schema';
import { completionCredits } from './task-credit';
import { logger } from '../logger';

/**
 * Badge catalog.
 *
 * Definitions live in code (not the DB) so adding a new badge is a code
 * change — checked into git, deployed atomically with any required
 * computation tweaks. The DB only stores who-earned-what-and-when.
 *
 * Each badge has:
 *   - `slug`: stable id (used as PK component on user_badges).
 *   - locale-specific `nameRu/nameEn` + `descRu/descEn`.
 *   - `icon`: an emoji glyph the UI renders inline.
 *   - `check(data)`: pure predicate over the aggregated user stats below.
 *     When `true`, the user qualifies; we insert ON CONFLICT DO NOTHING so
 *     subsequent re-evaluations are idempotent.
 *
 * Adding a badge: pick a slug, write the rule, ship. Older clients ignore
 * unknown slugs (the i18n map below is the source of truth for display).
 */

export type BadgeData = {
  totalCompletedTasks: number;
  totalPointsEarned: number;
  totalPhotos: number;
  /** Tasks of type 'queued' the user completed in this family. */
  queueWins: number;
  /** Longest run of consecutive days with at least one completion. */
  longestStreak: number;
  /** "Did at least one task on a Saturday OR Sunday." */
  doneOnWeekend: boolean;
  /** "Completed something before 09:00 local time." */
  doneBefore9: boolean;
  /** "Completed something at or after 21:00 local time." */
  doneAfter21: boolean;
};

export type BadgeDef = {
  slug: string;
  nameRu: string;
  nameEn: string;
  descRu: string;
  descEn: string;
  icon: string;
  check: (data: BadgeData) => boolean;
};

export const BADGES: BadgeDef[] = [
  {
    slug: 'first-task',
    nameRu: 'Старт',
    nameEn: 'First step',
    descRu: 'Первая выполненная задача',
    descEn: 'Completed your first task',
    icon: '🌱',
    check: (d) => d.totalCompletedTasks >= 1,
  },
  {
    slug: 'tasks-10',
    nameRu: '10 задач',
    nameEn: '10 tasks',
    descRu: 'Десяток за плечами',
    descEn: 'Knocked out ten tasks',
    icon: '🔟',
    check: (d) => d.totalCompletedTasks >= 10,
  },
  {
    slug: 'tasks-100',
    nameRu: 'Сотка',
    nameEn: '100 tasks',
    descRu: 'Сто завершённых задач',
    descEn: 'A hundred tasks done',
    icon: '💯',
    check: (d) => d.totalCompletedTasks >= 100,
  },
  {
    slug: 'tasks-500',
    nameRu: '500 задач',
    nameEn: '500 tasks',
    descRu: 'Завершено пятьсот задач',
    descEn: 'Five hundred tasks completed',
    icon: '🏆',
    check: (d) => d.totalCompletedTasks >= 500,
  },
  {
    slug: 'streak-3',
    nameRu: 'Серия 3',
    nameEn: 'Streak 3',
    descRu: '3 дня подряд с задачами',
    descEn: '3 consecutive days with tasks',
    icon: '🔥',
    check: (d) => d.longestStreak >= 3,
  },
  {
    slug: 'streak-7',
    nameRu: 'Серия 7',
    nameEn: 'Streak 7',
    descRu: 'Неделя без пропусков',
    descEn: 'A full week, no skips',
    icon: '🔥',
    check: (d) => d.longestStreak >= 7,
  },
  {
    slug: 'streak-30',
    nameRu: 'Серия 30',
    nameEn: 'Streak 30',
    descRu: 'Месяц подряд!',
    descEn: 'A whole month in a row',
    icon: '🌟',
    check: (d) => d.longestStreak >= 30,
  },
  {
    slug: 'photo-3',
    nameRu: 'Фотограф',
    nameEn: 'Photographer',
    descRu: '3 фото-отчёта',
    descEn: '3 photo reports',
    icon: '📷',
    check: (d) => d.totalPhotos >= 3,
  },
  {
    slug: 'photo-30',
    nameRu: 'Фотохроникёр',
    nameEn: 'Documentarian',
    descRu: '30 фото-отчётов',
    descEn: '30 photo reports',
    icon: '📸',
    check: (d) => d.totalPhotos >= 30,
  },
  {
    slug: 'queue-12',
    nameRu: 'Очередник',
    nameEn: 'Queue champion',
    descRu: '12 побед в очереди',
    descEn: '12 queue rotations completed',
    icon: '🔄',
    check: (d) => d.queueWins >= 12,
  },
  {
    slug: 'points-100',
    nameRu: '100 очков',
    nameEn: '100 points',
    descRu: 'Сто очков заработано',
    descEn: 'Earned a hundred points',
    icon: '⭐',
    check: (d) => d.totalPointsEarned >= 100,
  },
  {
    slug: 'points-1000',
    nameRu: '1000 очков',
    nameEn: '1000 points',
    descRu: 'Тысяча очков!',
    descEn: 'A thousand points!',
    icon: '✨',
    check: (d) => d.totalPointsEarned >= 1000,
  },
  {
    slug: 'weekend-warrior',
    nameRu: 'Выходной — не отдых',
    nameEn: 'Weekend warrior',
    descRu: 'Задача в субботу или воскресенье',
    descEn: 'Completed a task on a weekend',
    icon: '🛠️',
    check: (d) => d.doneOnWeekend,
  },
  {
    slug: 'early-bird',
    nameRu: 'Ранняя пташка',
    nameEn: 'Early bird',
    descRu: 'Выполнено до 9 утра',
    descEn: 'Completed before 9 am',
    icon: '🌅',
    check: (d) => d.doneBefore9,
  },
  {
    slug: 'night-owl',
    nameRu: 'Сова',
    nameEn: 'Night owl',
    descRu: 'Выполнено после 21:00',
    descEn: 'Completed after 9 pm',
    icon: '🌙',
    check: (d) => d.doneAfter21,
  },
];

/**
 * Gather the aggregates we need to evaluate every rule, in one pass over
 * the DB. The set is small (< 10 numbers) so we just compute everything
 * eagerly rather than per-rule — easier to reason about than lazy chains,
 * and the heaviest query (occurrences) runs once.
 */
export async function collectBadgeData(input: {
  familyId: string;
  userId: string;
}): Promise<BadgeData> {
  // Completed-task aggregates. We pull (completedAt, task.type, points,
  // hasPhoto-via-id-set) so a single query feeds counts + streak + flags.
  // Shared tasks credit every member on them, not only the person who
  // tapped "Выполнить" — same rule as points and the Stats counters (see
  // `completionCredits`). So we pull the family's done rows with the
  // task roster attached and filter in JS rather than matching
  // `completed_by = userId` in SQL, which would hide a joint chore from
  // every participant except one.
  const allRows = await db
    .select({
      taskType: tasks.type,
      completedAt: taskOccurrences.completedAt,
      pointsAwarded: taskOccurrences.pointsAwarded,
      completedBy: taskOccurrences.completedBy,
      participantIds: tasks.participantIds,
      assigneeId: tasks.assigneeId,
    })
    .from(taskOccurrences)
    .innerJoin(tasks, eq(taskOccurrences.taskId, tasks.id))
    .where(
      and(
        eq(tasks.familyId, input.familyId),
        eq(taskOccurrences.status, 'done'),
        isNotNull(taskOccurrences.completedBy),
      ),
    );
  const rows = allRows.filter((r) =>
    completionCredits(
      { participantIds: r.participantIds, assigneeId: r.assigneeId },
      r.completedBy!,
    ).includes(input.userId),
  );

  let totalCompletedTasks = 0;
  let totalPointsEarned = 0;
  let queueWins = 0;
  let doneOnWeekend = false;
  let doneBefore9 = false;
  let doneAfter21 = false;
  const dateSet = new Set<string>();

  for (const r of rows) {
    if (!r.completedAt) continue;
    totalCompletedTasks++;
    totalPointsEarned += r.pointsAwarded ?? 0;
    if (r.taskType === 'queued') queueWins++;
    const d = new Date(r.completedAt);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) doneOnWeekend = true;
    const hour = d.getUTCHours();
    if (hour < 9) doneBefore9 = true;
    if (hour >= 21) doneAfter21 = true;
    dateSet.add(r.completedAt.toISOString().slice(0, 10));
  }

  const longestStreak = computeLongestStreakFromDates(dateSet);

  // Photo count: a separate small query — task_photos has its own table.
  // We scope to this user + this family (via task join).
  const photoRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(taskPhotos)
    .innerJoin(tasks, eq(taskPhotos.taskId, tasks.id))
    .where(and(eq(tasks.familyId, input.familyId), eq(taskPhotos.userId, input.userId)));
  const totalPhotos = photoRows[0]?.count ?? 0;

  return {
    totalCompletedTasks,
    totalPointsEarned,
    totalPhotos,
    queueWins,
    longestStreak,
    doneOnWeekend,
    doneBefore9,
    doneAfter21,
  };
}

/**
 * Walk a sorted-unique date set, return the maximum run of consecutive
 * days. Equivalent to the Stats helper but operates on raw `YYYY-MM-DD`
 * strings so we can reuse it without touching the DB.
 *
 * Exported for unit tests.
 */
export function computeLongestStreakFromDates(dates: Set<string>): number {
  if (dates.size === 0) return 0;
  const sorted = Array.from(dates).sort();
  let longest = 1;
  let cur = 1;
  const DAY_MS = 86_400_000;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(`${sorted[i - 1]!}T00:00:00.000Z`).getTime();
    const curT = new Date(`${sorted[i]!}T00:00:00.000Z`).getTime();
    if (Math.round((curT - prev) / DAY_MS) === 1) {
      cur++;
      if (cur > longest) longest = cur;
    } else {
      cur = 1;
    }
  }
  return longest;
}

/**
 * Evaluate every badge against fresh aggregates and persist newly-earned
 * ones (ON CONFLICT DO NOTHING). Returns the slugs that were *newly*
 * awarded this call so the caller can show a "+1 badge!" surface.
 *
 * Called on every task completion via `occurrence-actions`. Cheap enough:
 * the heavy query already runs to compute stats; checking 15 rules over
 * the result set is negligible.
 */
export async function evaluateBadgesForUser(input: {
  familyId: string;
  userId: string;
}): Promise<string[]> {
  const data = await collectBadgeData(input);
  const qualifying = BADGES.filter((b) => b.check(data));
  if (qualifying.length === 0) return [];

  // Find which we already have so we can report only newly-earned ones.
  const existing = await db
    .select({ slug: userBadges.badgeSlug })
    .from(userBadges)
    .where(
      and(
        eq(userBadges.userId, input.userId),
        eq(userBadges.familyId, input.familyId),
        inArray(
          userBadges.badgeSlug,
          qualifying.map((b) => b.slug),
        ),
      ),
    );
  const have = new Set(existing.map((r) => r.slug));
  const fresh = qualifying.filter((b) => !have.has(b.slug));
  if (fresh.length === 0) return [];

  await db
    .insert(userBadges)
    .values(
      fresh.map((b) => ({
        userId: input.userId,
        familyId: input.familyId,
        badgeSlug: b.slug,
      })),
    )
    .onConflictDoNothing();

  logger.debug(
    { userId: input.userId, familyId: input.familyId, slugs: fresh.map((b) => b.slug) },
    'badges awarded',
  );
  return fresh.map((b) => b.slug);
}

/** Read all badges earned by a user in a family, joined with the catalog
 *  so the route can serialize names/icons without the client knowing the
 *  rule shape. */
export async function listBadgesForUser(input: {
  familyId: string;
  userId: string;
}): Promise<Array<UserBadgeRow & { def: BadgeDef }>> {
  const rows = await db
    .select()
    .from(userBadges)
    .where(
      and(
        eq(userBadges.userId, input.userId),
        eq(userBadges.familyId, input.familyId),
      ),
    );
  const bySlug = new Map(BADGES.map((b) => [b.slug, b]));
  return rows
    .filter((r) => bySlug.has(r.badgeSlug))
    .map((r) => ({ ...r, def: bySlug.get(r.badgeSlug)! }));
}

/** Newly-earned badges across the family in the last N days. Used by the
 *  "Recently earned" list in the MyProfile / MemberProfile UI. */
export async function listRecentBadgesForFamily(input: {
  familyId: string;
  sinceDays?: number;
}): Promise<UserBadgeRow[]> {
  const days = input.sinceDays ?? 30;
  const since = new Date(Date.now() - days * 86_400_000);
  return db
    .select()
    .from(userBadges)
    .where(and(eq(userBadges.familyId, input.familyId), gte(userBadges.earnedAt, since)));
}

export function serializeBadge(row: UserBadgeRow, def: BadgeDef, locale: string) {
  const isEn = locale.startsWith('en');
  return {
    slug: row.badgeSlug,
    name: isEn ? def.nameEn : def.nameRu,
    description: isEn ? def.descEn : def.descRu,
    icon: def.icon,
    earnedAt: row.earnedAt.toISOString(),
  };
}
