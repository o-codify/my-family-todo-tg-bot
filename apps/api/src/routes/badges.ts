import { Hono } from 'hono';
import { tgAuth, type AuthVariables } from '../middleware/auth';
import { requireFamily, type FamilyVariables } from '../middleware/family';
import {
  BADGES,
  listBadgesForUser,
  serializeBadge,
} from '../services/badges';

/**
 * Badges API.
 *
 * The catalog is fixed in code; clients call `GET /catalog` to render the
 * "all possible badges" picker (locked/unlocked view), and `GET /mine`
 * for just the earned ones. `GET /:userId` is the read-only view another
 * family member's profile uses.
 */
export const badgesRouter = new Hono<{ Variables: AuthVariables & FamilyVariables }>()
  .use('*', tgAuth)
  .use('*', requireFamily);

badgesRouter.get('/catalog', (c) => {
  const user = c.get('user');
  const isEn = user.locale.startsWith('en');
  return c.json({
    badges: BADGES.map((b) => ({
      slug: b.slug,
      name: isEn ? b.nameEn : b.nameRu,
      description: isEn ? b.descEn : b.descRu,
      icon: b.icon,
    })),
  });
});

badgesRouter.get('/mine', async (c) => {
  const user = c.get('user');
  const familyId = c.get('familyId');
  const rows = await listBadgesForUser({ familyId, userId: user.id });
  return c.json({
    badges: rows.map((r) => serializeBadge(r, r.def, user.locale)),
  });
});

badgesRouter.get('/:userId', async (c) => {
  const user = c.get('user');
  const familyId = c.get('familyId');
  const userId = c.req.param('userId');
  const rows = await listBadgesForUser({ familyId, userId });
  return c.json({
    badges: rows.map((r) => serializeBadge(r, r.def, user.locale)),
  });
});
