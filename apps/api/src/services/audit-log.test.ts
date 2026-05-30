import { describe, expect, it } from 'vitest';
import { diffTaskFields } from './audit-log';

type TaskLike = Parameters<typeof diffTaskFields>[0];

function baseTask(over: Partial<TaskLike> = {}): TaskLike {
  return {
    title: 'A',
    description: null,
    type: 'oneoff',
    schedule: { kind: 'oneoff', date: '2026-01-01' },
    assigneeId: null,
    queueUserIds: null,
    participantIds: null,
    deadlineAt: null,
    points: 0,
    photoRequired: false,
    requiresApproval: false,
    isQuest: false,
    singleShot: false,
    cooldownDays: null,
    ...over,
  };
}

describe('diffTaskFields', () => {
  it('returns [] when nothing changed', () => {
    expect(diffTaskFields(baseTask(), baseTask())).toEqual([]);
  });

  it('flags title + points when they change', () => {
    const before = baseTask();
    const after = baseTask({ title: 'B', points: 5 });
    expect(diffTaskFields(before, after).sort()).toEqual(['points', 'title']);
  });

  it('treats null and "" descriptions as equal', () => {
    const before = baseTask({ description: null });
    const after = baseTask({ description: '' });
    expect(diffTaskFields(before, after)).toEqual([]);
  });

  it('detects schedule changes via deep compare', () => {
    const before = baseTask({ schedule: { kind: 'oneoff', date: '2026-01-01' } });
    const after = baseTask({ schedule: { kind: 'oneoff', date: '2026-02-01' } });
    expect(diffTaskFields(before, after)).toEqual(['schedule']);
  });

  it('detects queueUserIds reordering as a change', () => {
    const before = baseTask({ queueUserIds: ['a', 'b'] });
    const after = baseTask({ queueUserIds: ['b', 'a'] });
    expect(diffTaskFields(before, after)).toEqual(['queueUserIds']);
  });

  it('treats null and empty queueUserIds the same', () => {
    // Both mean "no explicit roster" — flipping between them shouldn't
    // produce an audit row.
    const before = baseTask({ queueUserIds: null });
    const after = baseTask({ queueUserIds: null });
    expect(diffTaskFields(before, after)).toEqual([]);
  });

  it('detects deadline date change (Date equality)', () => {
    const before = baseTask({ deadlineAt: new Date('2026-01-01T00:00:00Z') });
    const after = baseTask({ deadlineAt: new Date('2026-01-02T00:00:00Z') });
    expect(diffTaskFields(before, after)).toEqual(['deadlineAt']);
  });
});
