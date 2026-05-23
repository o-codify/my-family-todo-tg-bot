import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client';
import { pointsLedger, taskOccurrences } from '../../src/db/schema';
import {
  approveOccurrence,
  completeOccurrence,
  getOccurrenceInFamily,
  listPendingApprovals,
  OccurrenceActionError,
  rejectOccurrence,
} from '../../src/services/occurrence-actions';
import { createTask } from '../../src/services/tasks';
import { addMember, closeDb, makeFamily, makeUser, resetTables } from '../db-helpers';

function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

describe('approval workflow (integration)', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('child completion on requiresApproval task lands in pending_approval; no points yet', async () => {
    const owner = await makeUser();
    const kid = await makeUser({ firstName: 'Kid' });
    const { family } = await makeFamily(owner);
    await addMember(family, kid, 'Child');

    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Clean room',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: tomorrow() },
        points: 10,
        photoRequired: false,
        requiresApproval: true,
        singleShot: false,
        assigneeId: kid.id,
      },
    });

    const occRows = await db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, task.id));
    const occId = occRows[0]!.id;
    const occ = await getOccurrenceInFamily(occId, family.id);
    const after = await completeOccurrence({
      occurrence: occ!,
      userId: kid.id,
      data: {},
    });
    expect(after.status).toBe('pending_approval');
    expect(after.completedBy).toBe(kid.id);
    expect(after.pointsAwarded).toBe(0);

    // No ledger entry yet.
    const ledger = await db
      .select()
      .from(pointsLedger)
      .where(eq(pointsLedger.userId, kid.id));
    expect(ledger).toHaveLength(0);
  });

  it('adult/owner completion on requiresApproval task goes straight to done', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Do thing',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: tomorrow() },
        points: 5,
        photoRequired: false,
        requiresApproval: true,
        singleShot: false,
      },
    });
    const occRows = await db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, task.id));
    const occ = await getOccurrenceInFamily(occRows[0]!.id, family.id);
    const after = await completeOccurrence({
      occurrence: occ!,
      userId: owner.id,
      data: {},
    });
    expect(after.status).toBe('done');
    expect(after.pointsAwarded).toBe(5);
  });

  it('approve flips pending_approval → done and awards points to the completer', async () => {
    const owner = await makeUser();
    const kid = await makeUser({ firstName: 'Kid' });
    const { family } = await makeFamily(owner);
    await addMember(family, kid, 'Child');
    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Clean room',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: tomorrow() },
        points: 10,
        photoRequired: false,
        requiresApproval: true,
        singleShot: false,
        assigneeId: kid.id,
      },
    });
    const occRows = await db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, task.id));
    const occ = await getOccurrenceInFamily(occRows[0]!.id, family.id);
    await completeOccurrence({ occurrence: occ!, userId: kid.id, data: {} });

    const approved = await approveOccurrence({
      occurrenceId: occ!.id,
      approverId: owner.id,
    });
    expect(approved?.status).toBe('done');
    expect(approved?.approvedBy).toBe(owner.id);
    expect(approved?.pointsAwarded).toBe(10);

    // Points went to the KID (completer), not the owner (approver).
    const ledger = await db
      .select()
      .from(pointsLedger)
      .where(eq(pointsLedger.userId, kid.id));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.delta).toBe(10);
  });

  it('reject flips back to pending, clears photo/completion, stores reason', async () => {
    const owner = await makeUser();
    const kid = await makeUser({ firstName: 'Kid' });
    const { family } = await makeFamily(owner);
    await addMember(family, kid, 'Child');
    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Clean room',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: tomorrow() },
        points: 10,
        photoRequired: false,
        requiresApproval: true,
        singleShot: false,
        assigneeId: kid.id,
      },
    });
    const occRows = await db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, task.id));
    const occ = await getOccurrenceInFamily(occRows[0]!.id, family.id);
    await completeOccurrence({ occurrence: occ!, userId: kid.id, data: {} });

    const rejected = await rejectOccurrence({
      occurrenceId: occ!.id,
      rejecterId: owner.id,
      reason: 'Books still on the floor',
    });
    expect(rejected?.status).toBe('pending');
    expect(rejected?.completedAt).toBeNull();
    expect(rejected?.completedBy).toBeNull();
    expect(rejected?.rejectedBy).toBe(owner.id);
    expect(rejected?.rejectionReason).toBe('Books still on the floor');
  });

  it('approving a non-pending_approval row throws wrong_status', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'No approval needed',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: tomorrow() },
        points: 0,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
      },
    });
    const occRows = await db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, task.id));
    await expect(
      approveOccurrence({ occurrenceId: occRows[0]!.id, approverId: owner.id }),
    ).rejects.toBeInstanceOf(OccurrenceActionError);
  });

  it('listPendingApprovals returns only pending_approval rows in the family', async () => {
    const owner = await makeUser();
    const kid = await makeUser({ firstName: 'Kid' });
    const { family } = await makeFamily(owner);
    await addMember(family, kid, 'Child');
    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'Clean room',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: tomorrow() },
        points: 1,
        photoRequired: false,
        requiresApproval: true,
        singleShot: false,
        assigneeId: kid.id,
      },
    });
    const occRows = await db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, task.id));
    const occ = await getOccurrenceInFamily(occRows[0]!.id, family.id);
    await completeOccurrence({ occurrence: occ!, userId: kid.id, data: {} });

    const pending = await listPendingApprovals(family.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(occ!.id);
  });

  it('child completes a task without requiresApproval → straight to done', async () => {
    const owner = await makeUser();
    const kid = await makeUser({ firstName: 'Kid' });
    const { family } = await makeFamily(owner);
    await addMember(family, kid, 'Child');
    const task = await createTask({
      familyId: family.id,
      createdBy: owner.id,
      data: {
        title: 'No gate',
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: tomorrow() },
        points: 3,
        photoRequired: false,
        requiresApproval: false,
        singleShot: false,
        assigneeId: kid.id,
      },
    });
    const occRows = await db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, task.id));
    const occ = await getOccurrenceInFamily(occRows[0]!.id, family.id);
    const after = await completeOccurrence({
      occurrence: occ!,
      userId: kid.id,
      data: {},
    });
    expect(after.status).toBe('done');
    expect(after.pointsAwarded).toBe(3);
  });
});
