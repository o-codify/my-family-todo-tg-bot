/**
 * End-to-end ICS-feed leak test: build a real family with two users
 * (Alice + Bob), seed every meaningful task shape (oneoff dated,
 * recurring, queue with rotation, floating, unassigned/shared, plus
 * done-completion variants), then generate the ICS feed for each user
 * and assert that personal tasks DON'T cross over.
 *
 * Motivated by user report: "Пользователь добавил календарь себе, а
 * в нем отображает и мои задачи." The personal-feed filter passes
 * unit-level scrutiny but this verifies the whole pipeline end to end
 * — query + presentation + queue forecast + dateless pending anchors
 * + family events.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client';
import {
  familyEvents,
  taskOccurrences,
  tasks,
} from '../../src/db/schema';
import { generateFamilyIcs } from '../../src/services/ics';
import { createTask } from '../../src/services/tasks';
import {
  addMember,
  closeDb,
  makeFamily,
  makeUser,
  resetTables,
} from '../db-helpers';

function isoNDays(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

describe('ICS feed: two-user personal-scope leak check (integration)', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("each user's feed contains theirs+shared and excludes the other's personal tasks", async () => {
    // ─── Seed: family with Alice (owner) + Bob (adult) ───────────────
    const alice = await makeUser({ firstName: 'Alice' });
    const bob = await makeUser({ firstName: 'Bob' });
    const { family } = await makeFamily(alice);
    await addMember(family, bob, 'Adult');

    const tomorrow = isoNDays(1);
    const inThree = isoNDays(3);
    const inFive = isoNDays(5);

    // 1. Alice-assigned oneoff dated
    const aliceTask = await createTask({
      familyId: family.id,
      createdBy: alice.id,
      data: {
        title: 'Alice-DishWash',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: tomorrow, time: '20:00' },
        assigneeId: alice.id,
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    // createTask doesn't propagate task.assigneeId → occurrence.assigneeId,
    // so we backfill (the real /complete + /assign flows handle this).
    await db
      .update(taskOccurrences)
      .set({ assigneeId: alice.id })
      .where(eq(taskOccurrences.taskId, aliceTask.id));

    // 2. Bob-assigned oneoff dated
    const bobTask = await createTask({
      familyId: family.id,
      createdBy: alice.id,
      data: {
        title: 'Bob-Vacuum',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: tomorrow, time: '18:00' },
        assigneeId: bob.id,
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    await db
      .update(taskOccurrences)
      .set({ assigneeId: bob.id })
      .where(eq(taskOccurrences.taskId, bobTask.id));

    // 3. Unassigned shared oneoff dated — both should see it.
    await createTask({
      familyId: family.id,
      createdBy: alice.id,
      data: {
        title: 'Shared-WashCar',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: inThree },
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });

    // 4. Queue task rotating [bob, alice], step=1 day. Current pending
    //    is on bob — so today's anchor is Bob's, tomorrow's forecast is
    //    Alice's, day after Bob's, etc.
    const queueTask = await createTask({
      familyId: family.id,
      createdBy: alice.id,
      data: {
        title: 'Trash',
        type: 'queued',
        schedule: { kind: 'queued' },
        queueUserIds: [bob.id, alice.id],
        cooldownDays: 1,
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    // Force the current pending head onto bob so the forecast math is
    // predictable in this test regardless of pickNextAssignee's choice.
    await db
      .update(taskOccurrences)
      .set({ assigneeId: bob.id, scheduledDate: null })
      .where(eq(taskOccurrences.taskId, queueTask.id));

    // 5. Bob-only floating task ("Когда-нибудь") — dateless pending.
    const [bobFloating] = await db
      .insert(tasks)
      .values({
        familyId: family.id,
        title: 'Bob-Someday',
        type: 'floating',
        schedule: { kind: 'floating' },
        createdBy: alice.id,
        assigneeId: bob.id,
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      })
      .returning();
    await db.insert(taskOccurrences).values({
      taskId: bobFloating!.id,
      scheduledDate: null,
      status: 'pending',
      assigneeId: bob.id,
    });

    // 6. Alice-completed done occurrence on Alice's task (different
    //    title so we can assert on it).
    const aliceDone = await createTask({
      familyId: family.id,
      createdBy: alice.id,
      data: {
        title: 'Alice-DoneTask',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: inFive },
        assigneeId: alice.id,
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    await db
      .update(taskOccurrences)
      .set({
        assigneeId: alice.id,
        status: 'done',
        completedAt: new Date(),
        completedBy: alice.id,
      })
      .where(eq(taskOccurrences.taskId, aliceDone.id));

    // 7. Family events — should appear in BOTH feeds (relaxed scope).
    await db.insert(familyEvents).values({
      familyId: family.id,
      type: 'birthday',
      title: 'Bob-Birthday',
      emoji: '🎂',
      month: 7,
      day: 4,
      year: 1990,
      memberUserId: bob.id,
      createdByUserId: alice.id,
    });

    // ─── Generate feeds ──────────────────────────────────────────────
    const aliceFeed = await generateFamilyIcs({
      familyId: family.id,
      userId: alice.id,
    });
    const bobFeed = await generateFamilyIcs({
      familyId: family.id,
      userId: bob.id,
    });

    // ─── Alice's feed expectations ───────────────────────────────────
    // Personal: hers, the shared one, the family event, and her queue
    // forecast days. Excludes: Bob's personal task, Bob's floating.
    expect(aliceFeed).toContain('SUMMARY:Alice-DishWash');
    expect(aliceFeed).toContain('SUMMARY:Shared-WashCar');
    expect(aliceFeed).toContain('SUMMARY:✓ Alice-DoneTask');
    expect(aliceFeed).toContain('🎂 Bob-Birthday');

    expect(aliceFeed).not.toContain('Bob-Vacuum');
    expect(aliceFeed).not.toContain('Bob-Someday');

    // Queue forecast: Alice's turn lands on tomorrow (one step from
    // today's Bob-pending). Today itself should NOT show Trash in
    // Alice's feed because the pending row is assigned to Bob.
    const tomorrowStamp = isoNDays(1).replace(/-/g, '');
    expect(aliceFeed).toContain(`DTSTART;VALUE=DATE:${tomorrowStamp}`);
    expect(aliceFeed).toMatch(/Trash/);

    // ─── Bob's feed expectations ─────────────────────────────────────
    // Personal: his + shared + family event + his queue current/forecast.
    // Excludes Alice's personal/done tasks.
    expect(bobFeed).toContain('SUMMARY:Bob-Vacuum');
    expect(bobFeed).toContain('SUMMARY:Shared-WashCar');
    expect(bobFeed).toContain('Bob-Someday');
    expect(bobFeed).toContain('🎂 Bob-Birthday');

    expect(bobFeed).not.toContain('Alice-DishWash');
    expect(bobFeed).not.toContain('Alice-DoneTask');

    // Bob sees Trash on today (his current pending anchored to today).
    expect(bobFeed).toMatch(/Trash/);
  });

  it('forecast for queue assigned to OTHER user does not appear in my feed', async () => {
    // A queue with only two members rotates "their turn / my turn" by
    // cooldownDays. Make sure the OTHER user's turn days don't leak
    // into my feed.
    const me = await makeUser({ firstName: 'Me' });
    const other = await makeUser({ firstName: 'Other' });
    const { family } = await makeFamily(me);
    await addMember(family, other, 'Adult');

    const queueTask = await createTask({
      familyId: family.id,
      createdBy: me.id,
      data: {
        title: 'Q',
        type: 'queued',
        schedule: { kind: 'queued' },
        // Cooldown=2 → rotation lands on alternating pairs of days.
        cooldownDays: 2,
        queueUserIds: [other.id, me.id],
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    // Pin the current head to `other` so today is their turn.
    await db
      .update(taskOccurrences)
      .set({ assigneeId: other.id, scheduledDate: null })
      .where(eq(taskOccurrences.taskId, queueTask.id));

    const feed = await generateFamilyIcs({
      familyId: family.id,
      userId: me.id,
    });

    // My turn is today + 2 days. Days 4, 6, 8… are also mine
    // (alternating). Day +2 should be in the feed.
    const day2 = isoNDays(2).replace(/-/g, '');
    expect(feed).toContain(`DTSTART;VALUE=DATE:${day2}`);

    // The current pending (today, assigned to `other`) must NOT be
    // anchored to today in MY feed — that's the leak case.
    const today = isoNDays(0).replace(/-/g, '');
    expect(feed).not.toContain(`DTSTART;VALUE=DATE:${today}`);
  });
});
