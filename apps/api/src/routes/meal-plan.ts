import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import {
  createMealPlanEntryInputSchema,
  updateMealPlanEntryInputSchema,
} from '@family-todo/shared';
import { tgAuth, type AuthVariables } from '../middleware/auth';
import { requireFamily, type FamilyVariables } from '../middleware/family';
import {
  createEntry,
  deleteEntry,
  listEntries,
  pushToShoppingList,
  restoreEntry,
  serializeMealPlanEntry,
  updateEntry,
} from '../services/meal-plan';

/**
 * Meal plan endpoints. List by date range (from/to query); CRUD by id;
 * `POST /:entryId/push-to-shopping` is the killer button — appends the
 * entry's ingredients to the family's shopping list.
 */
export const mealPlanRouter = new Hono<{
  Variables: AuthVariables & FamilyVariables;
}>()
  .use('*', tgAuth)
  .use('*', requireFamily);

mealPlanRouter.get('/', async (c) => {
  const familyId = c.get('familyId');
  const url = new URL(c.req.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return c.json({ error: 'invalid_range' }, 400);
  }
  const rows = await listEntries({ familyId, from, to });
  return c.json({ entries: rows.map(serializeMealPlanEntry) });
});

mealPlanRouter.post(
  '/',
  zValidator('json', createMealPlanEntryInputSchema),
  async (c) => {
    const user = c.get('user');
    const familyId = c.get('familyId');
    const row = await createEntry({
      familyId,
      userId: user.id,
      data: c.req.valid('json'),
    });
    return c.json({ entry: serializeMealPlanEntry(row) }, 201);
  },
);

mealPlanRouter.patch(
  '/:entryId',
  zValidator('json', updateMealPlanEntryInputSchema),
  async (c) => {
    const familyId = c.get('familyId');
    const row = await updateEntry({
      familyId,
      entryId: c.req.param('entryId'),
      patch: c.req.valid('json'),
    });
    if (!row) return c.json({ error: 'entry_not_found' }, 404);
    return c.json({ entry: serializeMealPlanEntry(row) });
  },
);

mealPlanRouter.delete('/:entryId', async (c) => {
  const familyId = c.get('familyId');
  const ok = await deleteEntry({ familyId, entryId: c.req.param('entryId') });
  if (!ok) return c.json({ error: 'entry_not_found' }, 404);
  return c.body(null, 204);
});

mealPlanRouter.post('/:entryId/restore', async (c) => {
  const familyId = c.get('familyId');
  const row = await restoreEntry({ familyId, entryId: c.req.param('entryId') });
  if (!row) return c.json({ error: 'entry_not_found' }, 404);
  return c.json({ entry: serializeMealPlanEntry(row) });
});

mealPlanRouter.post('/:entryId/push-to-shopping', async (c) => {
  const user = c.get('user');
  const familyId = c.get('familyId');
  const result = await pushToShoppingList({
    familyId,
    userId: user.id,
    entryId: c.req.param('entryId'),
  });
  if (!result) return c.json({ error: 'entry_not_found' }, 404);
  return c.json(result);
});
