import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cancelRequest,
  createRequest,
  decideRequest,
  listRequests,
} from '../../src/services/permission-requests';
import { closeDb, makeFamily, makeUser, resetTables } from '../db-helpers';

describe('permission requests (integration)', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('creates a request with status=pending', async () => {
    const owner = await makeUser();
    const kid = await makeUser({ firstName: 'Kid' });
    const { family } = await makeFamily(owner);
    const req = await createRequest({
      familyId: family.id,
      userId: kid.id,
      data: { type: 'screen_time', text: 'Можно мультики?' },
    });
    expect(req.status).toBe('pending');
    expect(req.requesterUserId).toBe(kid.id);
    expect(req.text).toBe('Можно мультики?');
  });

  it('approve flips pending → approved with decider + timestamp', async () => {
    const owner = await makeUser();
    const kid = await makeUser({ firstName: 'Kid' });
    const { family } = await makeFamily(owner);
    const req = await createRequest({
      familyId: family.id,
      userId: kid.id,
      data: { type: 'other', text: 'ask' },
    });
    const decided = await decideRequest({
      familyId: family.id,
      requestId: req.id,
      deciderUserId: owner.id,
      decision: 'approved',
      reason: 'OK only after homework',
    });
    expect(decided?.status).toBe('approved');
    expect(decided?.decidedByUserId).toBe(owner.id);
    expect(decided?.decisionReason).toBe('OK only after homework');
    expect(decided?.decidedAt).not.toBeNull();
  });

  it('decide is idempotent — re-deciding returns the existing terminal row', async () => {
    const owner = await makeUser();
    const kid = await makeUser({ firstName: 'Kid' });
    const { family } = await makeFamily(owner);
    const req = await createRequest({
      familyId: family.id,
      userId: kid.id,
      data: { type: 'other', text: 'x' },
    });
    await decideRequest({
      familyId: family.id,
      requestId: req.id,
      deciderUserId: owner.id,
      decision: 'denied',
    });
    const second = await decideRequest({
      familyId: family.id,
      requestId: req.id,
      deciderUserId: owner.id,
      decision: 'approved',
    });
    // Still denied — terminal status sticks.
    expect(second?.status).toBe('denied');
  });

  it('cancel only works for the requester and only on pending', async () => {
    const owner = await makeUser();
    const kid = await makeUser({ firstName: 'Kid' });
    const { family } = await makeFamily(owner);
    const req = await createRequest({
      familyId: family.id,
      userId: kid.id,
      data: { type: 'other', text: 'x' },
    });
    // Wrong user can't cancel.
    const wrong = await cancelRequest({
      familyId: family.id,
      requestId: req.id,
      userId: owner.id,
    });
    expect(wrong).toBeNull();
    // Requester can.
    const cancelled = await cancelRequest({
      familyId: family.id,
      requestId: req.id,
      userId: kid.id,
    });
    expect(cancelled?.status).toBe('cancelled');
  });

  it('list filters by status + requester', async () => {
    const owner = await makeUser();
    const kid = await makeUser({ firstName: 'Kid' });
    const { family } = await makeFamily(owner);
    await createRequest({
      familyId: family.id,
      userId: kid.id,
      data: { type: 'other', text: 'a' },
    });
    const second = await createRequest({
      familyId: family.id,
      userId: kid.id,
      data: { type: 'other', text: 'b' },
    });
    await decideRequest({
      familyId: family.id,
      requestId: second.id,
      deciderUserId: owner.id,
      decision: 'approved',
    });

    const pending = await listRequests({
      familyId: family.id,
      status: 'pending',
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.text).toBe('a');

    const all = await listRequests({ familyId: family.id });
    expect(all).toHaveLength(2);

    const kidOnly = await listRequests({
      familyId: family.id,
      requesterUserId: kid.id,
    });
    expect(kidOnly).toHaveLength(2);
  });
});
