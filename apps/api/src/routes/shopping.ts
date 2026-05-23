import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import {
  bulkAddShoppingItemsInputSchema,
  createShoppingItemInputSchema,
  updateShoppingItemInputSchema,
} from '@family-todo/shared';
import { tgAuth, type AuthVariables } from '../middleware/auth';
import { requireFamily, type FamilyVariables } from '../middleware/family';
import {
  addItem,
  addItemsBulk,
  archiveBought,
  deleteItem,
  getPrimaryListWithItems,
  restoreItem,
  serializeShoppingItem,
  serializeShoppingList,
  updateItem,
} from '../services/shopping';

/**
 * Shopping list endpoints. We expose only the family's primary list —
 * multiple-list support is a Phase D+ feature we don't need yet, and
 * keeping the URL flat (`/shopping`) avoids forcing the client to
 * remember a list id.
 */
export const shoppingRouter = new Hono<{ Variables: AuthVariables & FamilyVariables }>()
  .use('*', tgAuth)
  .use('*', requireFamily);

/** Full list + items. Auto-creates the primary list on first read. */
shoppingRouter.get('/', async (c) => {
  const familyId = c.get('familyId');
  const { list, items } = await getPrimaryListWithItems(familyId);
  return c.json({
    list: serializeShoppingList(list),
    items: items.map(serializeShoppingItem),
  });
});

shoppingRouter.post(
  '/items',
  zValidator('json', createShoppingItemInputSchema),
  async (c) => {
    const user = c.get('user');
    const familyId = c.get('familyId');
    const { list } = await getPrimaryListWithItems(familyId);
    const row = await addItem({
      familyId,
      listId: list.id,
      userId: user.id,
      data: c.req.valid('json'),
    });
    return c.json({ item: serializeShoppingItem(row) }, 201);
  },
);

shoppingRouter.post(
  '/items/bulk',
  zValidator('json', bulkAddShoppingItemsInputSchema),
  async (c) => {
    const user = c.get('user');
    const familyId = c.get('familyId');
    const { list } = await getPrimaryListWithItems(familyId);
    const { added, skipped } = await addItemsBulk({
      familyId,
      listId: list.id,
      userId: user.id,
      items: c.req.valid('json').items,
    });
    return c.json({ added: added.map(serializeShoppingItem), skipped });
  },
);

shoppingRouter.patch(
  '/items/:itemId',
  zValidator('json', updateShoppingItemInputSchema),
  async (c) => {
    const user = c.get('user');
    const familyId = c.get('familyId');
    const row = await updateItem({
      familyId,
      itemId: c.req.param('itemId'),
      userId: user.id,
      patch: c.req.valid('json'),
    });
    if (!row) return c.json({ error: 'item_not_found' }, 404);
    return c.json({ item: serializeShoppingItem(row) });
  },
);

shoppingRouter.delete('/items/:itemId', async (c) => {
  const familyId = c.get('familyId');
  const ok = await deleteItem({ familyId, itemId: c.req.param('itemId') });
  if (!ok) return c.json({ error: 'item_not_found' }, 404);
  return c.body(null, 204);
});

shoppingRouter.post('/items/:itemId/restore', async (c) => {
  const familyId = c.get('familyId');
  const row = await restoreItem({ familyId, itemId: c.req.param('itemId') });
  if (!row) return c.json({ error: 'item_not_found' }, 404);
  return c.json({ item: serializeShoppingItem(row) });
});

/** Archive all bought items older than N days (default: archive
 *  everything bought, regardless of age). */
shoppingRouter.post('/archive-bought', async (c) => {
  const familyId = c.get('familyId');
  const url = new URL(c.req.url);
  const daysParam = url.searchParams.get('olderThanDays');
  const days = daysParam ? Math.max(0, parseInt(daysParam, 10)) : 0;
  const { list } = await getPrimaryListWithItems(familyId);
  const archived = await archiveBought({
    familyId,
    listId: list.id,
    olderThanDays: days,
  });
  return c.json({ archived });
});
