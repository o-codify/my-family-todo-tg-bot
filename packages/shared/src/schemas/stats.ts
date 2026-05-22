import { z } from 'zod';

/**
 * Stats query — single `period` knob. We translate to a [from, to] window
 * server-side rather than letting the client pick arbitrary ranges, so the
 * server can pre-aggregate / cache per period later.
 */
export const statsPeriodSchema = z.enum(['week', 'month', 'all']);
export type StatsPeriod = z.infer<typeof statsPeriodSchema>;

export const statsQuerySchema = z.object({
  period: statsPeriodSchema.default('month'),
});
export type StatsQuery = z.infer<typeof statsQuerySchema>;

export const statsResponseSchema = z.object({
  period: z.object({
    kind: statsPeriodSchema,
    from: z.string(),
    to: z.string(),
  }),
  total: z.number().int().nonnegative(),
  byMember: z.array(
    z.object({
      userId: z.string().uuid(),
      count: z.number().int().nonnegative(),
      pointsEarned: z.number().int().nonnegative(),
    }),
  ),
  topTasks: z.array(
    z.object({
      taskId: z.string().uuid(),
      title: z.string(),
      count: z.number().int().nonnegative(),
    }),
  ),
  /**
   * Streak summary tailored to the requesting user + the family record. We
   * intentionally don't return every member's streak — the UI only shows
   * these two cells, and the per-user computation is the expensive part.
   */
  streaks: z.object({
    me: z.object({
      current: z.number().int().nonnegative(),
      longest: z.number().int().nonnegative(),
    }),
    familyBest: z.object({
      userId: z.string().uuid().nullable(),
      days: z.number().int().nonnegative(),
    }),
  }),
  unfairness: z.object({
    ratio: z.number(),
    topUserId: z.string().uuid().nullable(),
    bottomUserId: z.string().uuid().nullable(),
  }),
});
export type StatsResponse = z.infer<typeof statsResponseSchema>;
