import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client';
import { families } from '../../src/db/schema';
import { serializeFamily, updateFamily } from '../../src/services/families';
import { closeDb, makeFamily, makeUser, resetTables } from '../db-helpers';

describe('family pinned note (integration)', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('sets and serializes pinned note with editor + timestamp', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);

    const updated = await updateFamily({
      familyId: family.id,
      userId: owner.id,
      patch: { pinnedNote: '  В четверг гости  ' },
    });
    expect(updated?.pinnedNote).toBe('В четверг гости'); // trimmed
    expect(updated?.pinnedNoteUpdatedBy).toBe(owner.id);
    expect(updated?.pinnedNoteUpdatedAt).not.toBeNull();

    const serialized = serializeFamily(updated!);
    expect(serialized.pinnedNote).toBe('В четверг гости');
    expect(serialized.pinnedNoteUpdatedBy).toBe(owner.id);
    expect(typeof serialized.pinnedNoteUpdatedAt).toBe('string');
  });

  it('empty / whitespace-only note clears the field (null)', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    await updateFamily({
      familyId: family.id,
      userId: owner.id,
      patch: { pinnedNote: 'first' },
    });
    const cleared = await updateFamily({
      familyId: family.id,
      userId: owner.id,
      patch: { pinnedNote: '   ' },
    });
    expect(cleared?.pinnedNote).toBeNull();
    // Editor + timestamp still get stamped — auditing who cleared.
    expect(cleared?.pinnedNoteUpdatedBy).toBe(owner.id);
  });

  it('explicit null clears the note', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    await updateFamily({
      familyId: family.id,
      userId: owner.id,
      patch: { pinnedNote: 'something' },
    });
    const after = await updateFamily({
      familyId: family.id,
      userId: owner.id,
      patch: { pinnedNote: null },
    });
    expect(after?.pinnedNote).toBeNull();
  });

  it('pinned-note patch does not disturb name / avatarUrl', async () => {
    const owner = await makeUser();
    const { family } = await makeFamily(owner);
    const beforeRow = await db.query.families.findFirst({ where: eq(families.id, family.id) });
    const after = await updateFamily({
      familyId: family.id,
      userId: owner.id,
      patch: { pinnedNote: 'hi' },
    });
    expect(after?.name).toBe(beforeRow?.name);
    expect(after?.avatarUrl).toBe(beforeRow?.avatarUrl);
  });
});
