import { describe, expect, it } from 'vitest';
import { pickNextAssignee, type QueueCandidate } from './queue';

const baseDate = new Date('2026-01-01T00:00:00Z');

function cand(over: Partial<QueueCandidate> & { userId: string }): QueueCandidate {
  return { completions: 0, joinedAt: baseDate, isAway: false, ...over };
}

describe('pickNextAssignee', () => {
  it('returns nobody_available when list is empty', () => {
    expect(pickNextAssignee([])).toEqual({ kind: 'nobody_available' });
  });

  it('returns nobody_available when everyone is away', () => {
    expect(
      pickNextAssignee([cand({ userId: 'a', isAway: true }), cand({ userId: 'b', isAway: true })]),
    ).toEqual({ kind: 'nobody_available' });
  });

  it('picks the user with the fewest completions', () => {
    const result = pickNextAssignee([
      cand({ userId: 'a', completions: 5 }),
      cand({ userId: 'b', completions: 2 }),
      cand({ userId: 'c', completions: 3 }),
    ]);
    expect(result).toEqual({ kind: 'assigned', userId: 'b' });
  });

  it('skips away users even if they have fewer completions', () => {
    const result = pickNextAssignee([
      cand({ userId: 'a', completions: 0, isAway: true }),
      cand({ userId: 'b', completions: 4 }),
    ]);
    expect(result).toEqual({ kind: 'assigned', userId: 'b' });
  });

  it('breaks ties by earliest joinedAt', () => {
    const result = pickNextAssignee([
      cand({ userId: 'late', completions: 1, joinedAt: new Date('2026-03-01') }),
      cand({ userId: 'early', completions: 1, joinedAt: new Date('2026-01-01') }),
    ]);
    expect(result).toEqual({ kind: 'assigned', userId: 'early' });
  });

  it('rotates through users as completions accumulate', () => {
    // simulate 6 rounds: 3 users, equal joinedAt
    let counts = { a: 0, b: 0, c: 0 };
    const sequence: string[] = [];
    for (let i = 0; i < 6; i++) {
      const result = pickNextAssignee([
        cand({ userId: 'a', completions: counts.a }),
        cand({ userId: 'b', completions: counts.b }),
        cand({ userId: 'c', completions: counts.c }),
      ]);
      if (result.kind !== 'assigned') throw new Error('expected assigned');
      sequence.push(result.userId);
      counts[result.userId as keyof typeof counts]++;
    }
    // After 6 rounds with equal weights, each should be assigned exactly twice
    expect(counts).toEqual({ a: 2, b: 2, c: 2 });
    // Sequence should be a deterministic round-robin with our tie-breaker
    expect(sequence).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
  });

  it('alternates on equal counts via lastCompleterId', () => {
    // Two users, both have 1 completion. Without history info,
    // joinedAt tie-breaker would re-pick the first joiner — i.e.
    // "I did it last, but tomorrow it's me again" (the user
    // complaint). Passing lastCompleterId excludes them.
    const result = pickNextAssignee(
      [
        cand({ userId: 'me', completions: 1, joinedAt: new Date('2026-01-01') }),
        cand({ userId: 'other', completions: 1, joinedAt: new Date('2026-02-01') }),
      ],
      'me',
    );
    expect(result).toEqual({ kind: 'assigned', userId: 'other' });
  });

  it('keeps the last completer when they are the only one at min count', () => {
    // Same user did it last but is also behind on completions
    // (balance still says it's theirs to catch up on). They stay
    // picked.
    const result = pickNextAssignee(
      [
        cand({ userId: 'behind', completions: 0, joinedAt: new Date('2026-01-01') }),
        cand({ userId: 'ahead', completions: 5, joinedAt: new Date('2026-02-01') }),
      ],
      'behind',
    );
    expect(result).toEqual({ kind: 'assigned', userId: 'behind' });
  });

  it('two-user strict alternation: A, B, A, B with the lastCompleterId rule', () => {
    let counts = { a: 0, b: 0 };
    let last: string | null = null;
    const sequence: string[] = [];
    for (let i = 0; i < 4; i++) {
      const result = pickNextAssignee(
        [
          cand({ userId: 'a', completions: counts.a }),
          cand({ userId: 'b', completions: counts.b, joinedAt: new Date('2026-02-01') }),
        ],
        last,
      );
      if (result.kind !== 'assigned') throw new Error('expected assigned');
      sequence.push(result.userId);
      counts[result.userId as keyof typeof counts]++;
      last = result.userId;
    }
    expect(sequence).toEqual(['a', 'b', 'a', 'b']);
  });

  it('catches up an imbalanced queue', () => {
    // user a is behind; should be picked next several times until balanced
    let counts = { a: 0, b: 5, c: 5 };
    const sequence: string[] = [];
    for (let i = 0; i < 5; i++) {
      const result = pickNextAssignee([
        cand({ userId: 'a', completions: counts.a }),
        cand({ userId: 'b', completions: counts.b }),
        cand({ userId: 'c', completions: counts.c }),
      ]);
      if (result.kind !== 'assigned') throw new Error('expected assigned');
      sequence.push(result.userId);
      counts[result.userId as keyof typeof counts]++;
    }
    // a should get the first 5 picks
    expect(sequence).toEqual(['a', 'a', 'a', 'a', 'a']);
  });
});
