import { describe, expect, it } from 'vitest';
import { reminderRecipientIds, resolveIntervals, zonedDateTimeToUtc } from './reminder';

describe('reminderRecipientIds', () => {
  it('solo task → just the assignee', () => {
    expect(
      reminderRecipientIds({ assigneeId: 'u-a' }, { participantIds: null }),
    ).toEqual(['u-a']);
  });

  it('shared task → assignee plus participants', () => {
    expect(
      reminderRecipientIds({ assigneeId: 'u-a' }, { participantIds: ['u-b', 'u-c'] }),
    ).toEqual(['u-a', 'u-b', 'u-c']);
  });

  it('dedupes the assignee out of participants', () => {
    expect(
      reminderRecipientIds({ assigneeId: 'u-a' }, { participantIds: ['u-a', 'u-b'] }),
    ).toEqual(['u-a', 'u-b']);
  });

  it('drops a null assignee, keeps participants', () => {
    expect(
      reminderRecipientIds({ assigneeId: null }, { participantIds: ['u-b'] }),
    ).toEqual(['u-b']);
  });
});

describe('zonedDateTimeToUtc', () => {
  it('treats UTC tz as identity', () => {
    const d = zonedDateTimeToUtc('2026-05-21', '08:00', 'UTC');
    expect(d.toISOString()).toBe('2026-05-21T08:00:00.000Z');
  });

  it('subtracts Moscow offset (+3) to get UTC', () => {
    // 08:00 Moscow == 05:00 UTC
    const d = zonedDateTimeToUtc('2026-05-21', '08:00', 'Europe/Moscow');
    expect(d.toISOString()).toBe('2026-05-21T05:00:00.000Z');
  });

  it('handles negative offsets (Honolulu, -10)', () => {
    // 08:00 Honolulu == 18:00 UTC same day
    const d = zonedDateTimeToUtc('2026-05-21', '08:00', 'Pacific/Honolulu');
    expect(d.toISOString()).toBe('2026-05-21T18:00:00.000Z');
  });

  it('honors DST in Europe/Berlin (winter vs summer)', () => {
    // 09:00 Berlin in January is +1 → 08:00 UTC
    const winter = zonedDateTimeToUtc('2026-01-15', '09:00', 'Europe/Berlin');
    expect(winter.toISOString()).toBe('2026-01-15T08:00:00.000Z');
    // 09:00 Berlin in July is +2 → 07:00 UTC
    const summer = zonedDateTimeToUtc('2026-07-15', '09:00', 'Europe/Berlin');
    expect(summer.toISOString()).toBe('2026-07-15T07:00:00.000Z');
  });

  it('accepts HH:MM:SS too', () => {
    const d = zonedDateTimeToUtc('2026-05-21', '08:00:30', 'UTC');
    expect(d.toISOString()).toBe('2026-05-21T08:00:30.000Z');
  });
});

describe('resolveIntervals', () => {
  it('falls back to defaultReminderBeforeMinutes when array is absent', () => {
    expect(resolveIntervals({ defaultReminderBeforeMinutes: 15 })).toEqual([15]);
  });

  it('treats default 0 as "off" (empty array, no reminders)', () => {
    expect(resolveIntervals({ defaultReminderBeforeMinutes: 0 })).toEqual([]);
  });

  it('uses the array when present, even if old default would conflict', () => {
    expect(
      resolveIntervals({
        defaultReminderBeforeMinutes: 15,
        reminderIntervalsMinutes: [60, 15],
      }),
    ).toEqual([60, 15]);
  });

  it('strips zero entries from the array (zero means "off" per-slot)', () => {
    expect(
      resolveIntervals({
        defaultReminderBeforeMinutes: 15,
        reminderIntervalsMinutes: [60, 0, 15],
      }),
    ).toEqual([60, 15]);
  });

  it('empty array fully disables — overrides legacy default', () => {
    expect(
      resolveIntervals({
        defaultReminderBeforeMinutes: 15,
        reminderIntervalsMinutes: [],
      }),
    ).toEqual([]);
  });
});
