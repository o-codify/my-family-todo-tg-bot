import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { updateMeSchema } from '@family-todo/shared';
import { db } from '../db/client';
import { users } from '../db/schema';
import { tgAuth, type AuthVariables } from '../middleware/auth';
import { logger } from '../logger';
import { rescheduleDigestForUser } from '../queue/digest';
import { serializeUser } from '../services/users';

export const meRouter = new Hono<{ Variables: AuthVariables }>().use('*', tgAuth);

meRouter.get('/', (c) => {
  const user = c.get('user');
  return c.json(serializeUser(user));
});

meRouter.patch('/', zValidator('json', updateMeSchema), async (c) => {
  const user = c.get('user');
  const patch = c.req.valid('json');

  const next: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
  if (patch.color !== undefined) next.color = patch.color;
  if (patch.locale !== undefined) next.locale = patch.locale;
  if (patch.timezone !== undefined) next.timezone = patch.timezone;
  if (patch.notificationSettings !== undefined) {
    next.notificationSettings = { ...user.notificationSettings, ...patch.notificationSettings };
  }
  if (patch.awayUntil !== undefined) {
    next.awayUntil = patch.awayUntil ? new Date(patch.awayUntil) : null;
  }

  const [updated] = await db.update(users).set(next).where(eq(users.id, user.id)).returning();

  // If anything that affects the digest schedule changed, re-upsert the
  // repeatable job. Best-effort — a Redis hiccup shouldn't block the PATCH.
  const digestChanged =
    patch.notificationSettings?.digestEnabled !== undefined ||
    patch.notificationSettings?.digestTime !== undefined ||
    patch.timezone !== undefined;
  if (digestChanged && updated) {
    void rescheduleDigestForUser({
      userId: updated.id,
      digestEnabled: updated.notificationSettings.digestEnabled,
      digestTime: updated.notificationSettings.digestTime,
      timezone: updated.timezone,
    }).catch((err) => logger.warn({ err, userId: updated.id }, 'reschedule digest failed'));
  }

  return c.json(serializeUser(updated!));
});
