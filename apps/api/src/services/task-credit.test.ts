import { describe, expect, it } from 'vitest';
import { completionCredits } from './task-credit';

describe('completionCredits', () => {
  it('credits only the completer on a solo task', () => {
    expect(
      completionCredits({ participantIds: null, assigneeId: 'assignee' }, 'me'),
    ).toEqual(['me']);
  });

  it('treats an empty participant array as solo', () => {
    expect(
      completionCredits({ participantIds: [], assigneeId: 'assignee' }, 'me'),
    ).toEqual(['me']);
  });

  it('credits assignee + every participant on a shared task', () => {
    // "Г уборка" shape: responsible chazari, participants Vasis/~k/Zakir.
    // Zakir taps Выполнить -> all four must be credited, not just Zakir.
    const credits = completionCredits(
      { participantIds: ['vasis', 'k', 'zakir'], assigneeId: 'chazari' },
      'zakir',
    );
    expect(credits.sort()).toEqual(['chazari', 'k', 'vasis', 'zakir']);
  });

  it('includes the completer even when they are outside the roster', () => {
    // Someone not listed pitches in — they still did the work.
    const credits = completionCredits(
      { participantIds: ['vasis'], assigneeId: 'chazari' },
      'outsider',
    );
    expect(credits.sort()).toEqual(['chazari', 'outsider', 'vasis']);
  });

  it('does not duplicate a user who is both assignee and participant', () => {
    const credits = completionCredits(
      { participantIds: ['chazari', 'vasis'], assigneeId: 'chazari' },
      'chazari',
    );
    expect(credits).toHaveLength(2);
    expect(credits.sort()).toEqual(['chazari', 'vasis']);
  });

  it('falls back to the completer as base when the task has no assignee', () => {
    const credits = completionCredits(
      { participantIds: ['vasis'], assigneeId: null },
      'me',
    );
    expect(credits.sort()).toEqual(['me', 'vasis']);
  });
});
