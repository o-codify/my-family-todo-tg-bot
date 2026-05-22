/**
 * Pure helpers for the cooldown / single-shot lifecycle of floating tasks.
 * Database side-effects live in the service layer that calls these.
 */

export type CooldownDecision =
  | { kind: 'archive' } // single_shot floating — task is done forever
  | { kind: 'wait_then_reopen'; availableAt: Date }
  | { kind: 'reopen_immediately' };

export function decideAfterFloatingCompletion(input: {
  singleShot: boolean;
  cooldownDays: number | null;
  completedAt: Date;
}): CooldownDecision {
  if (input.singleShot) return { kind: 'archive' };
  if (input.cooldownDays && input.cooldownDays > 0) {
    const ms = input.cooldownDays * 24 * 60 * 60 * 1000;
    return {
      kind: 'wait_then_reopen',
      availableAt: new Date(input.completedAt.getTime() + ms),
    };
  }
  return { kind: 'reopen_immediately' };
}

/**
 * Whether a floating occurrence is currently selectable from the "Когда-нибудь"
 * list. Cooldown rows with availableAt in the future are hidden.
 */
export function isFloatingAvailable(input: {
  availableAt: Date | null;
  now?: Date;
}): boolean {
  if (!input.availableAt) return true;
  const now = input.now ?? new Date();
  return input.availableAt.getTime() <= now.getTime();
}
