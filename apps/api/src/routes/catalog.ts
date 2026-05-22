import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import {
  createCatalogItemSchema,
  updateCatalogItemSchema,
} from '@family-todo/shared';
import { tgAuth, type AuthVariables } from '../middleware/auth';
import { requireFamily, requirePermission, type FamilyVariables } from '../middleware/family';
import {
  createCatalogItem,
  deleteCatalogItem,
  listCatalog,
  serializeCatalogItem,
  updateCatalogItem,
} from '../services/catalog';

export const catalogRouter = new Hono<{ Variables: AuthVariables & FamilyVariables }>()
  .use('*', tgAuth)
  .use('*', requireFamily);

catalogRouter.get('/', async (c) => {
  const familyId = c.get('familyId');
  const q = c.req.query('q') ?? undefined;
  const items = await listCatalog(familyId, q);
  return c.json({ items: items.map(serializeCatalogItem) });
});

catalogRouter.post(
  '/',
  requirePermission('catalog.manage'),
  zValidator('json', createCatalogItemSchema),
  async (c) => {
    const user = c.get('user');
    const familyId = c.get('familyId');
    const item = await createCatalogItem({
      familyId,
      createdBy: user.id,
      data: c.req.valid('json'),
    });
    return c.json({ item: serializeCatalogItem(item) }, 201);
  },
);

catalogRouter.patch(
  '/:itemId',
  requirePermission('catalog.manage'),
  zValidator('json', updateCatalogItemSchema),
  async (c) => {
    const familyId = c.get('familyId');
    const itemId = c.req.param('itemId');
    const updated = await updateCatalogItem({ itemId, familyId, data: c.req.valid('json') });
    if (!updated) return c.json({ error: 'not_found' }, 404);
    return c.json({ item: serializeCatalogItem(updated) });
  },
);

catalogRouter.delete('/:itemId', requirePermission('catalog.manage'), async (c) => {
  const familyId = c.get('familyId');
  const itemId = c.req.param('itemId');
  const ok = await deleteCatalogItem({ itemId, familyId });
  if (!ok) return c.json({ error: 'not_found' }, 404);
  return c.body(null, 204);
});
