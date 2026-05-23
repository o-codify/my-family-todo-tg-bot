import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client';
import { taskOccurrences, tasks } from '../../src/db/schema';
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
    const ics = await generateFamilyIcs({ familyId: family.id, userId: owner.id });
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
    const ics = await generateFamilyIcs({ familyId: family.id, userId: owner.id });
    expect(ics).toContain(`DTSTART;VALUE=DATE:${y}${m}${d}`);
    // DTEND is the day AFTER per RFC 5545.
    const next = new Date(iso + 'T00:00:00Z');
    next.setUTCDate(next.getUTCDate() + 1);
    const ny = String(next.getUTCFullYear());
    const nm = String(next.getUTCMonth() + 1).padStart(2, '0');
    const nd = String(next.getUTCDate()).padStart(2, '0');
    expect(ics).toContain(`DTEND;VALUE=DATE:${ny}${nm}${nd}`);
  });

  it('includes done occurrences with ✓ prefix and STATUS:COMPLETED', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const created = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Wash dishes',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow(), time: '20:00' },
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    // Flip the freshly-created occurrence to 'done'. We bypass
    // completeOccurrence so this test stays focused on the ICS layer.
    await db
      .update(taskOccurrences)
      .set({ status: 'done', completedAt: new Date(), completedBy: owner.id })
      .where(eq(taskOccurrences.taskId, created.id));

    const ics = await generateFamilyIcs({ familyId: family.id, userId: owner.id });
    expect(ics).toContain('SUMMARY:✓ Wash dishes');
    expect(ics).toContain('STATUS:COMPLETED');
  });

  it('includes floating completions anchored on completedAt date', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    // Insert a task + a dateless occurrence (singleShot-style floating
    // completion). The createTask path for floating tasks usually leaves
    // the occurrence dateless; we replicate that shape directly.
    const [task] = await db
      .insert(tasks)
      .values({
        familyId: family.id,
        title: 'Spontaneous chore',
        type: 'floating',
        schedule: { kind: 'floating' },
        createdBy: owner.id,
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: true,
      })
      .returning();
    const today = new Date();
    await db.insert(taskOccurrences).values({
      taskId: task!.id,
      scheduledDate: null,
      status: 'done',
      completedAt: today,
      completedBy: owner.id,
    });

    const ics = await generateFamilyIcs({ familyId: family.id, userId: owner.id });
    const y = today.getUTCFullYear();
    const m = String(today.getUTCMonth() + 1).padStart(2, '0');
    const d = String(today.getUTCDate()).padStart(2, '0');
    expect(ics).toContain('SUMMARY:✓ Spontaneous chore');
    expect(ics).toContain(`DTSTART;VALUE=DATE:${y}${m}${d}`);
    expect(ics).toContain('STATUS:COMPLETED');
  });

  it('filters per-user: my assignments + unassigned, hides others', async () => {
    const me = await makeUser();
    const sibling = await makeUser();
    const { family } = await makeFamily(me);
    // Owner adds sibling as a member so we have two real users in family.
    const { addMember } = await import('../db-helpers');
    await addMember(family, sibling, 'Adult');

    // Three tasks: one assigned to me, one assigned to sibling, one
    // unassigned (shared). All scheduled for tomorrow.
    const tomorrow = isoTomorrow();
    const mine = await createTask({
      familyId: family.id,
      createdBy: me.id,
      data: {
        title: 'Mine',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: tomorrow },
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
        assigneeId: me.id,
      },
    });
    const theirs = await createTask({
      familyId: family.id,
      createdBy: me.id,
      data: {
        title: 'Theirs',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: tomorrow },
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
        assigneeId: sibling.id,
      },
    });
    await createTask({
      familyId: family.id,
      createdBy: me.id,
      data: {
        title: 'Shared',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: tomorrow },
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    // createTask doesn't propagate assigneeId to the occurrence — patch
    // it directly so the ICS query has something to filter on. This
    // matches what the in-app "assign" action does at runtime.
    await db
      .update(taskOccurrences)
      .set({ assigneeId: me.id })
      .where(eq(taskOccurrences.taskId, mine.id));
    await db
      .update(taskOccurrences)
      .set({ assigneeId: sibling.id })
      .where(eq(taskOccurrences.taskId, theirs.id));

    const ics = await generateFamilyIcs({ familyId: family.id, userId: me.id });
    expect(ics).toContain('SUMMARY:Mine');
    expect(ics).toContain('SUMMARY:Shared');
    expect(ics).not.toContain('SUMMARY:Theirs');
  });

  it('anchors dateless pending ("Когда-нибудь") on today as all-day', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const [task] = await db
      .insert(tasks)
      .values({
        familyId: family.id,
        title: 'Eventually',
        type: 'floating',
        schedule: { kind: 'floating' },
        createdBy: owner.id,
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      })
      .returning();
    await db.insert(taskOccurrences).values({
      taskId: task!.id,
      scheduledDate: null,
      status: 'pending',
    });

    const ics = await generateFamilyIcs({ familyId: family.id, userId: owner.id });
    const today = new Date();
    const y = today.getUTCFullYear();
    const m = String(today.getUTCMonth() + 1).padStart(2, '0');
    const d = String(today.getUTCDate()).padStart(2, '0');
    expect(ics).toContain('SUMMARY:Eventually');
    expect(ics).toContain(`DTSTART;VALUE=DATE:${y}${m}${d}`);
  });

  it('pending_approval and skipped get distinct prefixes + STATUS', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const pa = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Awaits ok',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow() },
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    const sk = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Skipped one',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow() },
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    await db
      .update(taskOccurrences)
      .set({ status: 'pending_approval' })
      .where(eq(taskOccurrences.taskId, pa.id));
    await db
      .update(taskOccurrences)
      .set({ status: 'skipped' })
      .where(eq(taskOccurrences.taskId, sk.id));

    const ics = await generateFamilyIcs({ familyId: family.id, userId: owner.id });
    expect(ics).toContain('SUMMARY:⏳ Awaits ok');
    expect(ics).toContain('STATUS:TENTATIVE');
    expect(ics).toContain('SUMMARY:⊘ Skipped one');
    expect(ics).toContain('STATUS:CANCELLED');
  });

  it('emits queue forecast VEVENTs on my-turn days', async () => {
    const me = await makeUser();
    const sibling = await makeUser();
    const { family } = await makeFamily(me);
    const { addMember } = await import('../db-helpers');
    await addMember(family, sibling, 'Adult');

    // Queue task: rotates [sibling, me], step = 1 day. Current pending
    // is on sibling — i.e. today is sibling's turn, tomorrow is mine.
    const [task] = await db
      .insert(tasks)
      .values({
        familyId: family.id,
        title: 'Trash',
        type: 'queued',
        schedule: { kind: 'queued' },
        createdBy: me.id,
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
        queueUserIds: [sibling.id, me.id],
        cooldownDays: 1,
      })
      .returning();
    await db.insert(taskOccurrences).values({
      taskId: task!.id,
      scheduledDate: null,
      status: 'pending',
      assigneeId: sibling.id,
    });

    const ics = await generateFamilyIcs({ familyId: family.id, userId: me.id });
    // Sibling's current turn isn't mine — should NOT be anchored to today
    // for me. But +1 day rotates to me — that forecast row SHOULD appear.
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const y = tomorrow.getUTCFullYear();
    const m = String(tomorrow.getUTCMonth() + 1).padStart(2, '0');
    const d = String(tomorrow.getUTCDate()).padStart(2, '0');
    expect(ics).toContain('SUMMARY:Trash');
    expect(ics).toContain(`DTSTART;VALUE=DATE:${y}${m}${d}`);
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
    const ics = await generateFamilyIcs({ familyId: family.id, userId: owner.id });
    // Each special char doubled-escaped per RFC 5545 §3.3.11.
    expect(ics).toContain('SUMMARY:A\\; B\\, C \\\\ D\\nE');
  });
});
