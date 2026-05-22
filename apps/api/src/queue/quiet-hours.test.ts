import { describe, expect, it } from 'vitest';
import { isInQuietHours, localDate, localHHMM } from './quiet-hours';

describe('quiet-hours', () => {
  it('returns false when quiet window is unset', () => {
    expect(isInQuietHours({ start: null, end: null, nowLocal: '03:00' })).toBe(false);
    expect(isInQuietHours({ start: '22:00', end: null, nowLocal: '03:00' })).toBe(false);
  });

  it('handles a simple daytime window (08:00–17:00)', () => {
    const inWindow = (t: string) =>
      isInQuietHours({ start: '08:00', end: '17:00', nowLocal: t });
    expect(inWindow('08:00')).toBe(true);
    expect(inWindow('12:30')).toBe(true);
    expect(inWindow('16:59')).toBe(true);
    expect(inWindow('17:00')).toBe(false); // exclusive upper bound
    expect(inWindow('07:59')).toBe(false);
    expect(inWindow('22:00')).toBe(false);
  });

  it('handles a wrap-around overnight window (22:00–08:00)', () => {
    const inWindow = (t: string) =>
      isInQuietHours({ start: '22:00', end: '08:00', nowLocal: t });
    expect(inWindow('22:00')).toBe(true);
    expect(inWindow('23:30')).toBe(true);
    expect(inWindow('00:01')).toBe(true);
    expect(inWindow('07:59')).toBe(true);
    expect(inWindow('08:00')).toBe(false);
    expect(inWindow('15:00')).toBe(false);
    expect(inWindow('21:59')).toBe(false);
  });

  it('returns false when start === end (degenerate)', () => {
    expect(
      isInQuietHours({ start: '10:00', end: '10:00', nowLocal: '10:00' }),
    ).toBe(false);
  });

  it('localHHMM produces HH:MM in given timezone', () => {
    // Pick a UTC instant that lies in two known offsets at once.
    const utc = new Date('2026-06-21T10:30:00.000Z');
    expect(localHHMM('UTC', utc)).toBe('10:30');
    expect(localHHMM('Europe/Moscow', utc)).toBe('13:30');
    expect(localHHMM('Asia/Tokyo', utc)).toBe('19:30');
  });

  it('localDate returns the date in the user timezone, not UTC', () => {
    // 23:30 UTC → next day in Moscow (+3).
    const utc = new Date('2026-06-21T23:30:00.000Z');
    expect(localDate('UTC', utc)).toBe('2026-06-21');
    expect(localDate('Europe/Moscow', utc)).toBe('2026-06-22');
    // 01:00 UTC June 22 → still June 21 in Honolulu (-10).
    const utc2 = new Date('2026-06-22T01:00:00.000Z');
    expect(localDate('Pacific/Honolulu', utc2)).toBe('2026-06-21');
  });
});
