import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client';
import { pointsLedger, taskOccurrences } from '../../src/db/schema';
import { bulkCompleteOccurrences } from '../../src/services/occurrence-actions';
import { createTask } from '../../src/services/tasks';
import { closeDb, makeFamily, makeUser, resetTables } from '../db-helpers';

function isoTomorrow(offset = 1): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

describe('bulk-complete occurrences (integration)', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('completes a mixed batch and reports per-id status', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const t1 = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'A',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow(1) },
        assigneeId: owner.id,
        points: 2,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    const t2 = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'B (photo required)',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow(2) },
        assigneeId: owner.id,
        points: 3,
        photoRequired: true, // bulk-complete passes no photo → fails
        requiresApproval: false,
        singleShot: false,
      },
    });
    const occs1 = await db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, t1.id));
    const occs2 = await db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, t2.id));
    const ids = [occs1[0]!.id, occs2[0]!.id, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'];

    const results = await bulkCompleteOccurrences({
      familyId: family.id,
      userId: owner.id,
      occurrenceIds: ids,
    });
    expect(results).toHaveLength(3);
    expect(results[0]?.status).toBe('done');
    expect(results[1]?.status).toBe('error');
    expect(results[1]?.error).toBe('photo_required');
    expect(results[2]?.status).toBe('error');
    expect(results[2]?.error).toBe('not_found');

    // Points ledger has only t1's award.
    const ledger = await db
      .select()
      .from(pointsLedger)
      .where(eq(pointsLedger.userId, owner.id));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.delta).toBe(2);
  });

  it("refuses to complete another member's assigned task", async () => {
    const owner = await makeUser();
    const other = await makeUser({ firstName: 'Other' });
    const { family } = await makeFamily(owner);
    const { addMember } = await import('../db-helpers');
    await addMember(family, other, 'Adult');

    const t = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: "Owner's task",
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow(1) },
        assigneeId: owner.id,
        points: 4,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    const occ = (
      await db.select().from(taskOccurrences).where(eq(taskOccurrences.taskId, t.id))
    )[0]!;

    // `other` tries to bulk-complete owner's task.
    const results = await bulkCompleteOccurrences({
      familyId: family.id,
      userId: other.id,
      occurrenceIds: [occ.id],
    });
    expect(results[0]?.status).toBe('error');
    expect(results[0]?.error).toBe('not_your_task');

    // No points were awarded to the impersonator.
    const ledger = await db
      .select()
      .from(pointsLedger)
      .where(eq(pointsLedger.userId, other.id));
    expect(ledger).toHaveLength(0);
  });

  it('respects the approval gate — gated rows return pending_approval', async () => {
    const owner = await makeUser();
    const kid = await makeUser({ firstName: 'Kid' });
    const { family } = await makeFamily(owner);
    const { addMember } = await import('../db-helpers');
    await addMember(family, kid, 'Child');

    const t = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Gated',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow(1) },
        assigneeId: kid.id,
        points: 5,
        photoRequired: false,
        requiresApproval: true,
        singleShot: false,
      },
    });
    const occ = (
      await db.select().from(taskOccurrences).where(eq(taskOccurrences.taskId, t.id))
    )[0]!;
    const results = await bulkCompleteOccurrences({
      familyId: family.id,
      userId: kid.id,
      occurrenceIds: [occ.id],
    });
    expect(results[0]?.status).toBe('pending_approval');
  });
});
