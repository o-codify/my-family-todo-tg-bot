import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  createShoppingItemInputSchema,
  updateShoppingItemInputSchema,
} from '@family-todo/shared';
import { tgAuth, type AuthVariables } from '../middleware/auth';
import { requireFamily, type FamilyVariables } from '../middleware/family';
import {
  addCatalogItemsToList,
  addItem,
  archiveBought,
  archiveList,
  createList,
  deleteItem,
  getListWithItems,
  listLists,
  moveItem,
  restoreItem,
  restoreList,
  serializeShoppingItem,
  serializeShoppingList,
  updateItem,
  updateList,
} from '../services/shopping';

/**
 * Shopping endpoints — multi-list model. Routes layout:
 *
 *   GET    /                         list of lists (with item counts)
 *   POST   /                         create a list
 *   GET    /:listId                  one list + its items
 *   PATCH  /:listId                  update name/assignee/dueDate
 *   DELETE /:listId                  archive
 *   POST   /:listId/restore          restore from archive
 *   POST   /:listId/items            add free-text item (auto-catalog)
 *   POST   /:listId/items/from-catalog   add picked catalog items
 *   POST   /:listId/archive-bought   sweep bought rows
 *   PATCH  /items/:itemId            update item
 *   DELETE /items/:itemId            soft-delete item
 *   POST   /items/:itemId/restore    undo soft delete
 *   POST   /items/:itemId/move       move to another list
 */
export const shoppingRouter = new Hono<{ Variables: AuthVariables & FamilyVariables }>()
  .use('*', tgAuth)
  .use('*', requireFamily);

const createListSchema = z.object({
  name: z.string().trim().min(1).max(80),
  assigneeUserId: z.string().uuid().nullable().optional(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
});
const updateListSchema = createListSchema.partial();

shoppingRouter.get('/', async (c) => {
  const familyId = c.get('familyId');
  const rows = await listLists({ familyId });
  return c.json({ lists: rows.map(serializeShoppingList) });
});

shoppingRouter.post('/', zValidator('json', createListSchema), async (c) => {
  const user = c.get('user');
  const familyId = c.get('familyId');
  const row = await createList({ familyId, userId: user.id, data: c.req.valid('json') });
  return c.json({ list: serializeShoppingList(row) }, 201);
});

shoppingRouter.get('/:listId', async (c) => {
  const familyId = c.get('familyId');
  const result = await getListWithItems({
    familyId,
    listId: c.req.param('listId'),
  });
  if (!result) return c.json({ error: 'list_not_found' }, 404);
  return c.json({
    list: serializeShoppingList(result.list),
    items: result.items.map(serializeShoppingItem),
  });
});

shoppingRouter.patch(
  '/:listId',
  zValidator('json', updateListSchema),
  async (c) => {
    const user = c.get('user');
    const familyId = c.get('familyId');
    const row = await updateList({
      familyId,
      listId: c.req.param('listId'),
      userId: user.id,
      patch: c.req.valid('json'),
    });
    if (!row) return c.json({ error: 'list_not_found' }, 404);
    return c.json({ list: serializeShoppingList(row) });
  },
);

shoppingRouter.delete('/:listId', async (c) => {
  const familyId = c.get('familyId');
  const ok = await archiveList({ familyId, listId: c.req.param('listId') });
  if (!ok) return c.json({ error: 'list_not_found' }, 404);
  return c.body(null, 204);
});

shoppingRouter.post('/:listId/restore', async (c) => {
  const familyId = c.get('familyId');
  const row = await restoreList({ familyId, listId: c.req.param('listId') });
  if (!row) return c.json({ error: 'list_not_found' }, 404);
  return c.json({ list: serializeShoppingList(row) });
});

shoppingRouter.post(
  '/:listId/items',
  zValidator(
    'json',
    createShoppingItemInputSchema.extend({
      catalogItemId: z.string().uuid().nullable().optional(),
    }),
  ),
  async (c) => {
    const user = c.get('user');
    const familyId = c.get('familyId');
    try {
      const row = await addItem({
        familyId,
        listId: c.req.param('listId'),
        userId: user.id,
        data: c.req.valid('json'),
      });
      return c.json({ item: serializeShoppingItem(row) }, 201);
    } catch (err) {
      if ((err as Error).message === 'list_not_found') {
        return c.json({ error: 'list_not_found' }, 404);
      }
      throw err;
    }
  },
);

shoppingRouter.post(
  '/:listId/items/from-catalog',
  zValidator(
    'json',
    z.object({ catalogItemIds: z.array(z.string().uuid()).min(1).max(100) }),
  ),
  async (c) => {
    const user = c.get('user');
    const familyId = c.get('familyId');
    try {
      const { added, skipped } = await addCatalogItemsToList({
        familyId,
        listId: c.req.param('listId'),
        userId: user.id,
        catalogItemIds: c.req.valid('json').catalogItemIds,
      });
      return c.json({ added: added.map(serializeShoppingItem), skipped });
    } catch (err) {
      if ((err as Error).message === 'list_not_found') {
        return c.json({ error: 'list_not_found' }, 404);
      }
      throw err;
    }
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

shoppingRouter.post(
  '/items/:itemId/move',
  zValidator('json', z.object({ targetListId: z.string().uuid() })),
  async (c) => {
    const familyId = c.get('familyId');
    const row = await moveItem({
      familyId,
      itemId: c.req.param('itemId'),
      targetListId: c.req.valid('json').targetListId,
    });
    if (!row) return c.json({ error: 'not_found_or_other_family' }, 404);
    return c.json({ item: serializeShoppingItem(row) });
  },
);

shoppingRouter.post('/:listId/archive-bought', async (c) => {
  const familyId = c.get('familyId');
  const url = new URL(c.req.url);
  const daysParam = url.searchParams.get('olderThanDays');
  const parsedDays = daysParam ? parseInt(daysParam, 10) : 0;
  const days = Number.isFinite(parsedDays) ? Math.max(0, parsedDays) : 0;
  const archived = await archiveBought({
    familyId,
    listId: c.req.param('listId'),
    olderThanDays: days,
  });
  return c.json({ archived });
});
