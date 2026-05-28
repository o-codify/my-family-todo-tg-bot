import { describe, expect, it } from 'vitest';
import type { TaskRow } from '../db/schema';
import { planOccurrencesForWindow } from './occurrences';

function makeTask(overrides: Partial<TaskRow>): TaskRow {
  return {
    id: 't-1',
    familyId: 'fam-1',
    title: 'Test',
    description: null,
    type: 'oneoff',
    schedule: { kind: 'oneoff', date: '2026-06-01' },
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
    subtasksTemplate: null,
    createdBy: 'u-1',
    archivedAt: null,
    createdAt: new Date('2026-05-21T00:00:00Z'),
    updatedAt: new Date('2026-05-21T00:00:00Z'),
    ...overrides,
  };
}

const WINDOW_START = new Date('2026-05-21T12:00:00Z');

describe('planOccurrencesForWindow', () => {
  describe('oneoff', () => {
    it('emits exactly one occurrence inside window', () => {
      const task = makeTask({
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: '2026-05-22' },
      });
      const result = planOccurrencesForWindow(task, WINDOW_START);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        taskId: 't-1',
        scheduledDate: '2026-05-22',
        status: 'pending',
      });
    });

    it('emits nothing when date is in the past', () => {
      const task = makeTask({
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: '2026-05-20' },
      });
      expect(planOccurrencesForWindow(task, WINDOW_START)).toHaveLength(0);
    });

    it('emits nothing when date is beyond 30-day window', () => {
      const task = makeTask({
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: '2026-07-01' },
      });
      expect(planOccurrencesForWindow(task, WINDOW_START)).toHaveLength(0);
    });

    it('attaches scheduledTime when present', () => {
      const task = makeTask({
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: '2026-05-22', time: '08:30' },
      });
      expect(planOccurrencesForWindow(task, WINDOW_START)[0]?.scheduledTime).toBe('08:30');
    });
  });

  describe('recurring daily', () => {
    it('emits 30 occurrences for daily', () => {
      const task = makeTask({
        type: 'recurring',
        schedule: { kind: 'recurring', recurrence: 'daily' },
      });
      const result = planOccurrencesForWindow(task, WINDOW_START);
      expect(result).toHaveLength(30);
      expect(result[0]?.scheduledDate).toBe('2026-05-21');
      expect(result[29]?.scheduledDate).toBe('2026-06-19');
    });
  });

  describe('recurring weekly', () => {
    it('emits only matching days of week', () => {
      // 2026-05-21 is Thursday (DOW=4). daysOfWeek=[1,3,5] = Mon, Wed, Fri.
      const task = makeTask({
        type: 'recurring',
        schedule: { kind: 'recurring', recurrence: 'weekly', daysOfWeek: [1, 3, 5] },
      });
      const result = planOccurrencesForWindow(task, WINDOW_START);
      // In a 30-day window starting Thu, expect roughly 12-13 occurrences (3 per week × ~4.3 weeks)
      expect(result.length).toBeGreaterThanOrEqual(12);
      expect(result.length).toBeLessThanOrEqual(14);

      // First match after Thu 21 should be Fri 22
      expect(result[0]?.scheduledDate).toBe('2026-05-22');
      // All dates must fall on Mon/Wed/Fri
      for (const occ of result) {
        const d = new Date(`${occ.scheduledDate}T00:00:00Z`);
        expect([1, 3, 5]).toContain(d.getUTCDay());
      }
    });

    it('emits zero when no days of week match', () => {
      const task = makeTask({
        type: 'recurring',
        schedule: { kind: 'recurring', recurrence: 'weekly', daysOfWeek: [] },
      });
      expect(planOccurrencesForWindow(task, WINDOW_START)).toHaveLength(0);
    });
  });

  describe('recurring interval', () => {
    it('emits every N days', () => {
      const task = makeTask({
        type: 'recurring',
        schedule: { kind: 'recurring', recurrence: 'interval', intervalDays: 3 },
      });
      const result = planOccurrencesForWindow(task, WINDOW_START);
      // 30 days / 3 = 10 occurrences (days 0, 3, 6, ..., 27)
      expect(result).toHaveLength(10);
      expect(result[0]?.scheduledDate).toBe('2026-05-21');
      expect(result[1]?.scheduledDate).toBe('2026-05-24');
    });
  });

  describe('floating and queued', () => {
    it('emits no occurrences for floating', () => {
      const task = makeTask({ type: 'floating', schedule: { kind: 'floating' } });
      expect(planOccurrencesForWindow(task, WINDOW_START)).toHaveLength(0);
    });

    it('emits no occurrences for queued', () => {
      const task = makeTask({ type: 'queued', schedule: { kind: 'queued' } });
      expect(planOccurrencesForWindow(task, WINDOW_START)).toHaveLength(0);
    });
  });

  describe('subtasks template', () => {
    it('copies template into each occurrence with done=false', () => {
      const task = makeTask({
        type: 'oneoff',
        schedule: { kind: 'oneoff', date: '2026-05-22' },
        subtasksTemplate: [
          { id: 's1', title: 'A', position: 0 },
          { id: 's2', title: 'B', position: 1 },
        ],
      });
      const result = planOccurrencesForWindow(task, WINDOW_START);
      expect(result[0]?.subtasks).toEqual([
        { id: 's1', title: 'A', position: 0, done: false },
        { id: 's2', title: 'B', position: 1, done: false },
      ]);
    });
  });
});
