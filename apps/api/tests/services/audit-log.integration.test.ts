import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  listAuditEvents,
  recordAuditEvent,
} from '../../src/services/audit-log';
import { closeDb, makeFamily, makeUser, resetTables } from '../db-helpers';

describe('audit log (integration)', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('recordAuditEvent persists and listAuditEvents returns it newest-first', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);

    await recordAuditEvent({
      familyId: family.id,
      actorUserId: owner.id,
      kind: 'task.create',
      entityType: 'task',
      entityId: 'task-xyz',
      entityTitle: 'Take out trash',
      details: { taskType: 'oneoff' },
    });

    await recordAuditEvent({
      familyId: family.id,
      actorUserId: owner.id,
      kind: 'task.update',
      entityType: 'task',
      entityId: 'task-xyz',
      entityTitle: 'Take out trash',
      details: { changedFields: ['title', 'points'] },
    });

    const events = await listAuditEvents({ familyId: family.id });
    expect(events).toHaveLength(2);
    // Newest first — task.update was inserted second.
    expect(events[0]!.kind).toBe('task.update');
    expect(events[1]!.kind).toBe('task.create');
    expect((events[0]!.details as { changedFields?: string[] }).changedFields)
      .toEqual(['title', 'points']);
  });

  it('listAuditEvents scopes to the requested family', async () => {
    const ownerA = await makeUser();
    const ownerB = await makeUser();
    const { family: famA } = await makeFamily(ownerA);
    const { family: famB } = await makeFamily(ownerB);

    await recordAuditEvent({
      familyId: famA.id,
      actorUserId: ownerA.id,
      kind: 'task.create',
      entityType: 'task',
      entityId: 't1',
      entityTitle: 'A-task',
    });
    await recordAuditEvent({
      familyId: famB.id,
      actorUserId: ownerB.id,
      kind: 'task.create',
      entityType: 'task',
      entityId: 't2',
      entityTitle: 'B-task',
    });

    const aFeed = await listAuditEvents({ familyId: famA.id });
    expect(aFeed.map((e) => e.entityTitle)).toEqual(['A-task']);
    const bFeed = await listAuditEvents({ familyId: famB.id });
    expect(bFeed.map((e) => e.entityTitle)).toEqual(['B-task']);
  });

  it('recordAuditEvent swallows DB errors without throwing', async () => {
    // Family doesn't exist — FK violation. Must not throw, must log
    // warning instead. We can't easily assert the warning, but the
    // absence of a thrown error proves the fire-and-forget contract.
    await expect(
      recordAuditEvent({
        familyId: '00000000-0000-0000-0000-000000000000',
        actorUserId: null,
        kind: 'task.create',
        entityType: 'task',
        entityId: 'whatever',
        entityTitle: 'x',
      }),
    ).resolves.toBeUndefined();
  });
});
