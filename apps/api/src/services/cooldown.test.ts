import { describe, expect, it } from 'vitest';
import { decideAfterFloatingCompletion, isFloatingAvailable } from './cooldown';

describe('decideAfterFloatingCompletion', () => {
  const completedAt = new Date('2026-05-21T10:00:00Z');

  it('archives single_shot tasks', () => {
    expect(
      decideAfterFloatingCompletion({ singleShot: true, cooldownDays: null, completedAt }),
    ).toEqual({ kind: 'archive' });
  });

  it('reopens immediately when no cooldown', () => {
    expect(
      decideAfterFloatingCompletion({ singleShot: false, cooldownDays: null, completedAt }),
    ).toEqual({ kind: 'reopen_immediately' });
  });

  it('reopens immediately when cooldown is 0', () => {
    expect(
      decideAfterFloatingCompletion({ singleShot: false, cooldownDays: 0, completedAt }),
    ).toEqual({ kind: 'reopen_immediately' });
  });

  it('schedules reopen after cooldownDays', () => {
    const result = decideAfterFloatingCompletion({
      singleShot: false,
      cooldownDays: 7,
      completedAt,
    });
    expect(result.kind).toBe('wait_then_reopen');
    if (result.kind === 'wait_then_reopen') {
      expect(result.availableAt.toISOString()).toBe('2026-05-28T10:00:00.000Z');
    }
  });
});

describe('isFloatingAvailable', () => {
  const now = new Date('2026-05-21T12:00:00Z');

  it('is available when availableAt is null', () => {
    expect(isFloatingAvailable({ availableAt: null, now })).toBe(true);
  });

  it('is available when availableAt is in the past', () => {
    expect(
      isFloatingAvailable({ availableAt: new Date('2026-05-20T12:00:00Z'), now }),
    ).toBe(true);
  });

  it('is unavailable when availableAt is in the future', () => {
    expect(
      isFloatingAvailable({ availableAt: new Date('2026-05-22T12:00:00Z'), now }),
    ).toBe(false);
  });

  it('is available at the exact availableAt moment', () => {
    expect(isFloatingAvailable({ availableAt: now, now })).toBe(true);
  });
});
