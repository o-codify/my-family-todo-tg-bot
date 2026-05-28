import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client';
import { pointsLedger, taskOccurrences } from '../../src/db/schema';
import {
  OccurrenceActionError,
  completeOccurrence,
  getOccurrenceInFamily,
} from '../../src/services/occurrence-actions';
import { createTask } from '../../src/services/tasks';
import { closeDb, makeFamily, makeUser, resetTables } from '../db-helpers';

function isoTomorrow(offset = 1): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

describe('completeOccurrence idempotency (integration)', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('does not award points twice on a repeated complete', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Award once',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: isoTomorrow(1) },
        assigneeId: owner.id,
        points: 5,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    const occ = (
      await db.select().from(taskOccurrences).where(eq(taskOccurrences.taskId, task.id))
    )[0]!;

    const first = await completeOccurrence({
      occurrence: { ...occ, task },
      userId: owner.id,
      data: {},
    });
    expect(first.status).toBe('done');

    // Re-fetch (now 'done') and try again — must be rejected.
    const reloaded = (await getOccurrenceInFamily(occ.id, family.id))!;
    await expect(
      completeOccurrence({ occurrence: reloaded, userId: owner.id, data: {} }),
    ).rejects.toBeInstanceOf(OccurrenceActionError);

    // Even replaying the stale (pending-looking) row must not double-award,
    // because the conditional UPDATE no longer matches a 'done' row.
    await expect(
      completeOccurrence({ occurrence: { ...occ, task }, userId: owner.id, data: {} }),
    ).rejects.toBeInstanceOf(OccurrenceActionError);

    const ledger = await db
      .select()
      .from(pointsLedger)
      .where(eq(pointsLedger.userId, owner.id));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.delta).toBe(5);
  });
});
