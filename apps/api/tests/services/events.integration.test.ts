import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ageAtNextOccurrence,
  createEvent,
  daysUntil,
  deleteEvent,
  listEvents,
  nextOccurrence,
  restoreEvent,
  updateEvent,
} from '../../src/services/events';
import { closeDb, makeFamily, makeUser, resetTables } from '../db-helpers';

describe('family events (integration)', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('creates and lists events ordered by month/day', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    await createEvent({
      familyId: family.id,
      userId: owner.id,
      data: { type: 'birthday', title: 'B', month: 6, day: 1 },
    });
    await createEvent({
      familyId: family.id,
      userId: owner.id,
      data: { type: 'birthday', title: 'A', month: 3, day: 15 },
    });
    const rows = await listEvents({ familyId: family.id });
    expect(rows.map((r) => r.title)).toEqual(['A', 'B']);
  });

  it('updateEvent patches only provided fields', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const ev = await createEvent({
      familyId: family.id,
      userId: owner.id,
      data: { type: 'birthday', title: 'Anya', month: 5, day: 10, year: 1995 },
    });
    const updated = await updateEvent({
      familyId: family.id,
      eventId: ev.id,
      patch: { title: 'Anna', notifyDaysBefore: [0] },
    });
    expect(updated?.title).toBe('Anna');
    expect(updated?.month).toBe(5); // unchanged
    expect(updated?.year).toBe(1995); // unchanged
    expect(updated?.notifyDaysBefore).toEqual([0]);
  });

  it('soft-delete + restore round-trips', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const ev = await createEvent({
      familyId: family.id,
      userId: owner.id,
      data: { type: 'custom', title: 'Anniv', month: 9, day: 5 },
    });
    expect(await deleteEvent({ familyId: family.id, eventId: ev.id })).toBe(true);
    const afterDel = await listEvents({ familyId: family.id });
    expect(afterDel).toHaveLength(0);

    const restored = await restoreEvent({ familyId: family.id, eventId: ev.id });
    expect(restored?.deletedAt).toBeNull();
    const afterRestore = await listEvents({ familyId: family.id });
    expect(afterRestore).toHaveLength(1);
  });

  it('nextOccurrence: future date in current year stays in current year', () => {
    // today: 2026-03-15. Birthday Jun 1 → next is 2026-06-01.
    const today = new Date(Date.UTC(2026, 2, 15));
    const next = nextOccurrence(6, 1, today);
    expect(next.toISOString().slice(0, 10)).toBe('2026-06-01');
  });

  it('nextOccurrence: past date in current year rolls to next year', () => {
    // today: 2026-12-10. Birthday Mar 15 → next is 2027-03-15.
    const today = new Date(Date.UTC(2026, 11, 10));
    const next = nextOccurrence(3, 15, today);
    expect(next.toISOString().slice(0, 10)).toBe('2027-03-15');
  });

  it('nextOccurrence: today returns today (inclusive)', () => {
    const today = new Date(Date.UTC(2026, 5, 1));
    const next = nextOccurrence(6, 1, today);
    expect(next.toISOString().slice(0, 10)).toBe('2026-06-01');
  });

  it('nextOccurrence: Feb 29 in a non-leap year falls back to Feb 28', () => {
    // 2026 is not a leap year. Compute "next Feb 29" starting Jan 1 2026.
    const today = new Date(Date.UTC(2026, 0, 1));
    const next = nextOccurrence(2, 29, today);
    // We expect Feb 28, 2026 — the same year, shifted day.
    expect(next.toISOString().slice(0, 10)).toBe('2026-02-28');
  });

  it('daysUntil: 0 on the day, 1 tomorrow', () => {
    const today = new Date(Date.UTC(2026, 5, 1));
    expect(daysUntil(6, 1, today)).toBe(0);
    expect(daysUntil(6, 2, today)).toBe(1);
  });

  it('ageAtNextOccurrence: returns target age', () => {
    const today = new Date(Date.UTC(2026, 4, 1)); // 2026-05-01
    expect(ageAtNextOccurrence(1990, 6, 1, today)).toBe(36);
    expect(ageAtNextOccurrence(null, 6, 1, today)).toBeNull();
  });

  it('ageAtNextOccurrence: counts year-roll correctly', () => {
    // birthday in past (Mar 15) of 2026 → next is 2027 → age 2027-1990 = 37
    const today = new Date(Date.UTC(2026, 11, 10));
    expect(ageAtNextOccurrence(1990, 3, 15, today)).toBe(37);
  });
});
