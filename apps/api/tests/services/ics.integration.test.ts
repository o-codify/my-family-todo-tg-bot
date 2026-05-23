import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  findActiveToken,
  generateFamilyIcs,
  issueToken,
  resolveToken,
  revokeActiveToken,
} from '../../src/services/ics';
import { createTask } from '../../src/services/tasks';
import { closeDb, makeFamily, makeUser, resetTables } from '../db-helpers';

function isoTomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe('ICS feed (integration)', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('issueToken rotates: previous one revoked, new one active', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const first = await issueToken({ userId: owner.id, familyId: family.id });
    const second = await issueToken({ userId: owner.id, familyId: family.id });
    expect(first.token).not.toBe(second.token);
    expect(await resolveToken(first.token)).toBeNull(); // revoked
    expect(await resolveToken(second.token)).toEqual({
      userId: owner.id,
      familyId: family.id,
    });
    const active = await findActiveToken({ userId: owner.id, familyId: family.id });
    expect(active?.token).toBe(second.token);
  });

  it('revokeActiveToken: subsequent resolveToken returns null', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const t = await issueToken({ userId: owner.id, familyId: family.id });
    expect(await revokeActiveToken({ userId: owner.id, familyId: family.id })).toBe(
      true,
    );
    expect(await resolveToken(t.token)).toBeNull();
  });

  it('generateFamilyIcs emits VEVENT per pending dated occurrence', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Take out trash',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow(), time: '08:30' },
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    const ics = await generateFamilyIcs({ familyId: family.id });
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('SUMMARY:Take out trash');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('END:VEVENT');
    expect(ics).toContain('END:VCALENDAR');
  });

  it('all-day events emit VALUE=DATE and DTEND on the next day', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    // Use a near-future date so syncOccurrencesForTask actually
    // generates the occurrence row (its window is bounded).
    const target = new Date();
    target.setDate(target.getDate() + 3);
    const iso = target.toISOString().slice(0, 10);
    const y = iso.slice(0, 4);
    const m = iso.slice(5, 7);
    const d = iso.slice(8, 10);
    await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'All day',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: iso },
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    const ics = await generateFamilyIcs({ familyId: family.id });
    expect(ics).toContain(`DTSTART;VALUE=DATE:${y}${m}${d}`);
    // DTEND is the day AFTER per RFC 5545.
    const next = new Date(iso + 'T00:00:00Z');
    next.setUTCDate(next.getUTCDate() + 1);
    const ny = String(next.getUTCFullYear());
    const nm = String(next.getUTCMonth() + 1).padStart(2, '0');
    const nd = String(next.getUTCDate()).padStart(2, '0');
    expect(ics).toContain(`DTEND;VALUE=DATE:${ny}${nm}${nd}`);
  });

  it('escaping: commas, semicolons, backslashes, newlines in title', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'A; B, C \\ D\nE',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow() },
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    const ics = await generateFamilyIcs({ familyId: family.id });
    // Each special char doubled-escaped per RFC 5545 §3.3.11.
    expect(ics).toContain('SUMMARY:A\\; B\\, C \\\\ D\\nE');
  });
});
