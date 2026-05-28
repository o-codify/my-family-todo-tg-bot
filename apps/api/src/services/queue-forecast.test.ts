import { describe, expect, it } from 'vitest';
import { forecastQueueOccurrences } from './queue-forecast';
import type { TaskRow } from '../db/schema';

/**
 * The forecast walks `pickNextAssignee` step by step starting at the
 * CURRENT pending row's turn. If that row carries a future
 * `availableAt` (it's on cooldown), the anchor must be `availableAt`,
 * NOT today — otherwise the chain shifts forward by the gap between
 * completion and now and the user sees "счёт с сегодняшнего дня, а не
 * с последнего выполнения".
 */

function makeTask(over: Partial<TaskRow> = {}): TaskRow {
  const base: TaskRow = {
    id: 'task-1',
    familyId: 'fam-1',
    title: 'Trash',
    description: null,
    type: 'queued',
    schedule: { kind: 'queued' },
    assigneeId: null,
    queueUserIds: ['user-a', 'user-b'],
    participantIds: null,
    deadlineAt: null,
    points: 0,
    photoRequired: false,
    requiresApproval: false,
    isQuest: false,
    singleShot: false,
    cooldownDays: 3,
    subtasksTemplate: null,
    createdBy: 'user-a',
    archivedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
  return { ...base, ...over };
}

function isoToMs(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getTime();
}

describe('forecastQueueOccurrences — cooldown anchor', () => {
  it('anchors the next rotation on availableAt + step, not today + step', () => {
    // Today is 2026-05-10. The current pending was spawned yesterday
    // (completion 2026-05-09) with cooldownDays=3, so availableAt is
    // 2026-05-12. The next rotation should land on 2026-05-15 (= avail
    // + 3 days), NOT 2026-05-13 (= today + 3).
    const todayIso = '2026-05-10';
    const toIso = '2026-05-20';
    const availableAt = new Date('2026-05-12T00:00:00Z');

    const out = forecastQueueOccurrences({
      tasks: [makeTask()],
      occurrences: [
        {
          taskId: 'task-1',
          status: 'pending',
          assigneeId: 'user-a',
          scheduledTime: null,
          availableAt,
        },
      ],
      memberIds: ['user-a', 'user-b'],
      completionsByTaskUser: new Map([
        ['task-1:user-a', 1],
        ['task-1:user-b', 0],
      ]),
      lastCompleterByTask: new Map([['task-1', 'user-a']]),
      joinedAtByUser: new Map([
        ['user-a', new Date('2025-01-01')],
        ['user-b', new Date('2025-01-02')],
      ]),
      todayIso,
      toIso,
    });

    // First forecast row = availableAt + 3 days = 2026-05-15.
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.scheduledDate).toBe('2026-05-15');
    // user-b is behind (0 completions vs user-a's 1), so they pick it up.
    expect(out[0]!.assigneeId).toBe('user-b');
  });

  it('falls back to today + step when there is no availableAt (no cooldown)', () => {
    const todayIso = '2026-05-10';
    const toIso = '2026-05-20';
    const out = forecastQueueOccurrences({
      tasks: [makeTask({ cooldownDays: null })],
      occurrences: [
        {
          taskId: 'task-1',
          status: 'pending',
          assigneeId: 'user-a',
          scheduledTime: null,
          availableAt: null,
        },
      ],
      memberIds: ['user-a', 'user-b'],
      completionsByTaskUser: new Map(),
      lastCompleterByTask: new Map(),
      joinedAtByUser: new Map([
        ['user-a', new Date('2025-01-01')],
        ['user-b', new Date('2025-01-02')],
      ]),
      todayIso,
      toIso,
    });
    // Step defaults to 1 day when cooldown is null — first forecast =
    // 2026-05-11 (= today + 1).
    expect(out[0]!.scheduledDate).toBe('2026-05-11');
  });

  it('treats availableAt-in-the-past the same as no cooldown', () => {
    // Past availableAt means cooldown has already lapsed — the row is
    // due today. Forecast picks up from today + step.
    const todayIso = '2026-05-10';
    const toIso = '2026-05-20';
    const out = forecastQueueOccurrences({
      tasks: [makeTask()],
      occurrences: [
        {
          taskId: 'task-1',
          status: 'pending',
          assigneeId: 'user-a',
          scheduledTime: null,
          availableAt: new Date('2026-05-05T00:00:00Z'),
        },
      ],
      memberIds: ['user-a', 'user-b'],
      completionsByTaskUser: new Map(),
      lastCompleterByTask: new Map(),
      joinedAtByUser: new Map([
        ['user-a', new Date('2025-01-01')],
        ['user-b', new Date('2025-01-02')],
      ]),
      todayIso,
      toIso,
    });
    // First forecast = today + 3 days = 2026-05-13.
    expect(out[0]!.scheduledDate).toBe('2026-05-13');
  });
});

// keep referenced so tsc strict-unused doesn't flag the import
void isoToMs;
