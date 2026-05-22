import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client';
import { taskOccurrences, tasks } from '../../src/db/schema';
import { computeFamilyStats, computeStreakForDates } from '../../src/services/stats';
import { addMember, closeDb, makeFamily, makeUser, resetTables } from '../db-helpers';

describe('stats service (integration)', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('returns zero counts for fresh families', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);

    const stats = await computeFamilyStats({
      familyId: family.id,
      requestingUserId: owner.id,
      period: 'month',
    });
    expect(stats.total).toBe(0);
    expect(stats.byMember).toHaveLength(1);
    expect(stats.byMember[0]).toMatchObject({ userId: owner.id, count: 0, pointsEarned: 0 });
    expect(stats.topTasks).toHaveLength(0);
    expect(stats.streaks.me.current).toBe(0);
    expect(stats.streaks.familyBest.days).toBe(0);
    expect(stats.unfairness.ratio).toBe(0);
  });

  it('counts done occurrences per member and ranks them', async () => {
    const owner = await makeUser();
    const adult = await makeUser();
    const { family } = await makeFamily(owner);
    await addMember(family, adult, 'Adult');

    // Seed a task + two done occurrences for owner, one for adult.
    const [task] = await db
      .insert(tasks)
      .values({
        familyId: family.id,
        title: 'Wash dishes',
        type: 'recurring',
        schedule: { kind: 'recurring', recurrence: 'daily' },
        createdBy: owner.id,
        points: 3,
      })
      .returning();
    const now = new Date();
    await db.insert(taskOccurrences).values([
      {
        taskId: task!.id,
        status: 'done',
        completedAt: new Date(now.getTime() - 86_400_000),
        completedBy: owner.id,
        pointsAwarded: 3,
      },
      {
        taskId: task!.id,
        status: 'done',
        completedAt: new Date(now.getTime() - 2 * 86_400_000),
        completedBy: owner.id,
        pointsAwarded: 3,
      },
      {
        taskId: task!.id,
        status: 'done',
        completedAt: new Date(now.getTime() - 3 * 86_400_000),
        completedBy: adult.id,
        pointsAwarded: 3,
      },
    ]);

    const stats = await computeFamilyStats({
      familyId: family.id,
      requestingUserId: owner.id,
      period: 'month',
    });
    expect(stats.total).toBe(3);
    expect(stats.byMember[0]).toMatchObject({ userId: owner.id, count: 2, pointsEarned: 6 });
    expect(stats.byMember[1]).toMatchObject({ userId: adult.id, count: 1, pointsEarned: 3 });
    expect(stats.topTasks).toEqual([
      { taskId: task!.id, title: 'Wash dishes', count: 3 },
    ]);
    // owner did task 2 days running (yesterday + day before) — current streak 2,
    // longest 2.
    expect(stats.streaks.me.longest).toBeGreaterThanOrEqual(2);
    expect(stats.unfairness.ratio).toBe(2);
    expect(stats.unfairness.topUserId).toBe(owner.id);
    expect(stats.unfairness.bottomUserId).toBe(adult.id);
  });

  it('ignores completions outside the period window', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const [task] = await db
      .insert(tasks)
      .values({
        familyId: family.id,
        title: 'Old',
        type: 'recurring',
        schedule: { kind: 'recurring', recurrence: 'daily' },
        createdBy: owner.id,
      })
      .returning();
    // Two weeks ago — outside the 'week' window.
    await db.insert(taskOccurrences).values({
      taskId: task!.id,
      status: 'done',
      completedAt: new Date(Date.now() - 14 * 86_400_000),
      completedBy: owner.id,
      pointsAwarded: 0,
    });
    const weekStats = await computeFamilyStats({
      familyId: family.id,
      requestingUserId: owner.id,
      period: 'week',
    });
    expect(weekStats.total).toBe(0);
    const monthStats = await computeFamilyStats({
      familyId: family.id,
      requestingUserId: owner.id,
      period: 'month',
    });
    expect(monthStats.total).toBe(1);
  });

  it('computeStreakForDates: current streak resets when last activity is > yesterday', () => {
    const now = new Date('2026-05-21T12:00:00.000Z');
    const dates = new Set(['2026-05-15', '2026-05-16', '2026-05-17']);
    const s = computeStreakForDates(dates, now);
    expect(s.longest).toBe(3);
    expect(s.current).toBe(0); // last day is May 17 — not today or yesterday
  });

  it('computeStreakForDates: counts current run anchored to today', () => {
    const now = new Date('2026-05-21T12:00:00.000Z');
    const dates = new Set(['2026-05-19', '2026-05-20', '2026-05-21']);
    const s = computeStreakForDates(dates, now);
    expect(s.current).toBe(3);
    expect(s.longest).toBe(3);
  });
});
