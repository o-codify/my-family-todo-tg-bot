import { describe, expect, it } from 'vitest';
import { mergePreferences } from './users';

describe('mergePreferences', () => {
  it('returns a new object — does not mutate the existing bag', () => {
    const existing = { calendarViewMode: 'month' };
    const merged = mergePreferences(existing, { viewedTutorial: true });
    expect(existing).toEqual({ calendarViewMode: 'month' });
    expect(merged).not.toBe(existing);
  });

  it('treats missing existing as empty', () => {
    expect(mergePreferences(null, { a: 1 })).toEqual({ a: 1 });
    expect(mergePreferences(undefined, { a: 1 })).toEqual({ a: 1 });
  });

  it('shallow-merges patch over existing', () => {
    const merged = mergePreferences(
      { calendarViewMode: 'month', viewedTutorial: false },
      { calendarViewMode: 'week' },
    );
    expect(merged).toEqual({ calendarViewMode: 'week', viewedTutorial: false });
  });

  it('strips keys explicitly set to null in the patch', () => {
    const merged = mergePreferences(
      { calendarViewMode: 'week', viewedTutorial: true },
      { viewedTutorial: null },
    );
    expect(merged).toEqual({ calendarViewMode: 'week' });
    expect('viewedTutorial' in merged).toBe(false);
  });

  it('strips keys nullified in existing too (legacy cleanup)', () => {
    // If a row was saved before pruning was added, mergePreferences should
    // still clean up nulls left in the existing bag — otherwise a no-op
    // patch on a dirty row would keep the nulls.
    const merged = mergePreferences({ stale: null, keep: 'yes' }, {});
    expect(merged).toEqual({ keep: 'yes' });
  });

  it('lets a key be re-set after a previous clear', () => {
    const after = mergePreferences({ calendarViewMode: 'week' }, { calendarViewMode: null });
    expect(after).toEqual({});
    const reset = mergePreferences(after, { calendarViewMode: 'agenda' });
    expect(reset).toEqual({ calendarViewMode: 'agenda' });
  });
});
