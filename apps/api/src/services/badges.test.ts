import { describe, expect, it } from 'vitest';
import { BADGES, computeLongestStreakFromDates, type BadgeData } from './badges';

const emptyData: BadgeData = {
  totalCompletedTasks: 0,
  totalPointsEarned: 0,
  totalPhotos: 0,
  queueWins: 0,
  longestStreak: 0,
  doneOnWeekend: false,
  doneBefore9: false,
  doneAfter21: false,
};

function bySlug(slug: string) {
  const b = BADGES.find((x) => x.slug === slug);
  if (!b) throw new Error(`badge ${slug} missing from catalog`);
  return b;
}

describe('computeLongestStreakFromDates', () => {
  it('returns 0 for empty set', () => {
    expect(computeLongestStreakFromDates(new Set())).toBe(0);
  });

  it('counts a single day as 1', () => {
    expect(computeLongestStreakFromDates(new Set(['2026-05-01']))).toBe(1);
  });

  it('treats consecutive days as one run', () => {
    expect(
      computeLongestStreakFromDates(new Set(['2026-05-01', '2026-05-02', '2026-05-03'])),
    ).toBe(3);
  });

  it('finds the longest run when there are gaps', () => {
    expect(
      computeLongestStreakFromDates(
        new Set([
          '2026-05-01',
          '2026-05-02', // 2-day run
          '2026-05-05',
          '2026-05-06',
          '2026-05-07',
          '2026-05-08', // 4-day run — winner
          '2026-05-15', // singleton
        ]),
      ),
    ).toBe(4);
  });

  it('handles unordered input (set provides no ordering)', () => {
    expect(
      computeLongestStreakFromDates(new Set(['2026-05-03', '2026-05-01', '2026-05-02'])),
    ).toBe(3);
  });
});

describe('badge rules', () => {
  it('first-task triggers at 1', () => {
    expect(bySlug('first-task').check({ ...emptyData })).toBe(false);
    expect(bySlug('first-task').check({ ...emptyData, totalCompletedTasks: 1 })).toBe(true);
  });

  it('tasks-100 triggers at exactly 100', () => {
    expect(bySlug('tasks-100').check({ ...emptyData, totalCompletedTasks: 99 })).toBe(false);
    expect(bySlug('tasks-100').check({ ...emptyData, totalCompletedTasks: 100 })).toBe(true);
  });

  it('streak-7 cares about longest, not current', () => {
    // A user's *current* streak could be 0 (broke it yesterday) but the
    // streak-7 badge stays earned forever once unlocked.
    expect(bySlug('streak-7').check({ ...emptyData, longestStreak: 6 })).toBe(false);
    expect(bySlug('streak-7').check({ ...emptyData, longestStreak: 7 })).toBe(true);
  });

  it('photo-3 triggers at 3 photo reports', () => {
    expect(bySlug('photo-3').check({ ...emptyData, totalPhotos: 2 })).toBe(false);
    expect(bySlug('photo-3').check({ ...emptyData, totalPhotos: 3 })).toBe(true);
  });

  it('queue-12 needs 12 queue completions', () => {
    expect(bySlug('queue-12').check({ ...emptyData, queueWins: 11 })).toBe(false);
    expect(bySlug('queue-12').check({ ...emptyData, queueWins: 12 })).toBe(true);
  });

  it('weekend-warrior fires on any weekend completion', () => {
    expect(bySlug('weekend-warrior').check({ ...emptyData, doneOnWeekend: false })).toBe(false);
    expect(bySlug('weekend-warrior').check({ ...emptyData, doneOnWeekend: true })).toBe(true);
  });

  it('time-of-day badges are independent', () => {
    const morning = { ...emptyData, doneBefore9: true };
    const evening = { ...emptyData, doneAfter21: true };
    expect(bySlug('early-bird').check(morning)).toBe(true);
    expect(bySlug('night-owl').check(morning)).toBe(false);
    expect(bySlug('early-bird').check(evening)).toBe(false);
    expect(bySlug('night-owl').check(evening)).toBe(true);
  });

  it('catalog slugs are all unique', () => {
    const slugs = BADGES.map((b) => b.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
