import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client';
import { familyEvents, taskOccurrences, tasks } from '../../src/db/schema';
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

  it('excludes done occurrences from the feed entirely', async () => {
    // External calendar is forward-looking; the user explicitly asked
    // "не передавать выполненные задачи". Done rows must not show up
    // even with their previous ✓/COMPLETED treatment.
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
    await db
      .update(taskOccurrences)
      .set({ status: 'done', completedAt: new Date(), completedBy: owner.id })
      .where(eq(taskOccurrences.taskId, created.id));

    const ics = await generateFamilyIcs({ familyId: family.id, userId: owner.id });
    expect(ics).not.toContain('Wash dishes');
    expect(ics).not.toContain('STATUS:COMPLETED');
  });

  it('dedupes multiple dateless pending rows for the same task into one event', async () => {
    // Regression: real prod state had two `pending dateless` rows for
    // the same floating task (legacy from the completeFloatingTask
    // assignee-NULL bug). Both anchored to today and the feed showed
    // "И" twice. The dedupe pass should collapse them to a single
    // VEVENT.
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const [task] = await db
      .insert(tasks)
      .values({
        familyId: family.id,
        title: 'Dup-Floating',
        type: 'floating',
        schedule: { kind: 'floating' },
        createdBy: owner.id,
        assigneeId: owner.id,
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      })
      .returning();
    // Insert TWO dateless pending occurrences, both assigned to owner.
    await db.insert(taskOccurrences).values([
      { taskId: task!.id, scheduledDate: null, status: 'pending', assigneeId: owner.id },
      { taskId: task!.id, scheduledDate: null, status: 'pending', assigneeId: owner.id },
    ]);

    const ics = await generateFamilyIcs({ familyId: family.id, userId: owner.id });
    // Exactly one SUMMARY:Dup-Floating line should appear (not two).
    const matches = ics.match(/SUMMARY:Dup-Floating/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('excludes dateless done (floating completion) from the feed', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
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
    await db.insert(taskOccurrences).values({
      taskId: task!.id,
      scheduledDate: null,
      status: 'done',
      completedAt: new Date(),
      completedBy: owner.id,
    });

    const ics = await generateFamilyIcs({ familyId: family.id, userId: owner.id });
    expect(ics).not.toContain('Spontaneous chore');
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

  it('emits annual VEVENT for family birthdays with RRULE', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    await db.insert(familyEvents).values({
      familyId: family.id,
      type: 'birthday',
      title: 'Anna',
      emoji: '🎂',
      month: 3,
      day: 15,
      year: 1990,
      createdByUserId: owner.id,
    });

    const ics = await generateFamilyIcs({ familyId: family.id, userId: owner.id });
    const yy = new Date().getUTCFullYear();
    const expectedAge = yy - 1990;
    expect(ics).toContain(`DTSTART;VALUE=DATE:${yy}0315`);
    expect(ics).toContain('RRULE:FREQ=YEARLY');
    expect(ics).toContain(`SUMMARY:🎂 Anna (${expectedAge})`);
  });

  it('excludes soft-deleted family events from the feed', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    await db.insert(familyEvents).values({
      familyId: family.id,
      type: 'custom',
      title: 'Removed',
      month: 6,
      day: 1,
      createdByUserId: owner.id,
      deletedAt: new Date(),
    });

    const ics = await generateFamilyIcs({ familyId: family.id, userId: owner.id });
    expect(ics).not.toContain('SUMMARY:🎂 Removed');
    expect(ics).not.toContain('Removed');
  });

  it('synthesises today VEVENT for a floating task with NO occurrence row', async () => {
    // Bug fix: a freshly-created `floating` task has no row in
    // task_occurrences because planOccurrencesForWindow returns [] for
    // floating/queued. Without synthesis the ICS feed silently drops
    // it. The in-app calendar synthesises a today-anchor placeholder
    // — ICS must do the same.
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    await db.insert(tasks).values({
      familyId: family.id,
      title: 'Wipe counter',
      type: 'floating',
      schedule: { kind: 'floating' },
      assigneeId: owner.id,
      createdBy: owner.id,
      points: 0,
      photoRequired: false,
      requiresApproval: false,
      singleShot: false,
    });

    const ics = await generateFamilyIcs({ familyId: family.id, userId: owner.id });
    const today = new Date();
    const y = today.getUTCFullYear();
    const m = String(today.getUTCMonth() + 1).padStart(2, '0');
    const d = String(today.getUTCDate()).padStart(2, '0');
    expect(ics).toContain('SUMMARY:Wipe counter');
    expect(ics).toContain(`DTSTART;VALUE=DATE:${y}${m}${d}`);
  });

  it('floating synthesis: skips a task whose cooldown is still active', async () => {
    // After completion of a floating task with cooldownDays>0 there's
    // a pending row seeded with availableAt = completedAt + N days.
    // While availableAt > now the task is "on cooldown" and must not
    // appear in the calendar — the user explicitly added the
    // qualifier "Но это если кд позволяет".
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const [task] = await db
      .insert(tasks)
      .values({
        familyId: family.id,
        title: 'Vacuum',
        type: 'floating',
        schedule: { kind: 'floating' },
        assigneeId: owner.id,
        createdBy: owner.id,
        cooldownDays: 6,
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      })
      .returning();
    // Existing pending row with future availableAt — this is what
    // completeFloatingTask seeds when wait_then_reopen fires.
    const future = new Date(Date.now() + 5 * 86_400_000);
    await db.insert(taskOccurrences).values({
      taskId: task!.id,
      scheduledDate: null,
      status: 'pending',
      assigneeId: owner.id,
      availableAt: future,
    });

    const ics = await generateFamilyIcs({ familyId: family.id, userId: owner.id });
    expect(ics).not.toContain('SUMMARY:Vacuum');
  });

  it('floating synthesis: cooldown elapsed → today anchor returns', async () => {
    // A floating task completed 10 days ago with a 6-day cooldown is
    // available again — must appear on today.
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const [task] = await db
      .insert(tasks)
      .values({
        familyId: family.id,
        title: 'Mop floor',
        type: 'floating',
        schedule: { kind: 'floating' },
        assigneeId: owner.id,
        createdBy: owner.id,
        cooldownDays: 6,
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      })
      .returning();
    // Old done row 10 days ago — no pending row (the reopen failed or
    // was archived elsewhere; either way the synthesis must kick in).
    await db.insert(taskOccurrences).values({
      taskId: task!.id,
      scheduledDate: null,
      status: 'done',
      completedAt: new Date(Date.now() - 10 * 86_400_000),
      completedBy: owner.id,
    });

    const ics = await generateFamilyIcs({ familyId: family.id, userId: owner.id });
    const today = new Date();
    const y = today.getUTCFullYear();
    const m = String(today.getUTCMonth() + 1).padStart(2, '0');
    const d = String(today.getUTCDate()).padStart(2, '0');
    expect(ics).toContain('SUMMARY:Mop floor');
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
