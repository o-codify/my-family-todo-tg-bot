import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import {
  createFamilyEventInputSchema,
  updateFamilyEventInputSchema,
} from '@family-todo/shared';
import { tgAuth, type AuthVariables } from '../middleware/auth';
import { requireFamily, type FamilyVariables } from '../middleware/family';
import {
  createEvent,
  deleteEvent,
  listEvents,
  restoreEvent,
  serializeFamilyEvent,
  updateEvent,
} from '../services/events';

/**
 * Family events endpoints — birthdays, anniversaries, important dates.
 * One list per family; rows are yearly-recurring (month/day stored, not
 * a full date). The client computes "next occurrence" + "days until"
 * from the stored fields (helpers in `services/events.ts`).
 */
export const familyEventsRouter = new Hono<{
  Variables: AuthVariables & FamilyVariables;
}>()
  .use('*', tgAuth)
  .use('*', requireFamily);

familyEventsRouter.get('/', async (c) => {
  const familyId = c.get('familyId');
  const rows = await listEvents({ familyId });
  return c.json({ events: rows.map(serializeFamilyEvent) });
});

familyEventsRouter.post(
  '/',
  zValidator('json', createFamilyEventInputSchema),
  async (c) => {
    const user = c.get('user');
    const familyId = c.get('familyId');
    const row = await createEvent({
      familyId,
      userId: user.id,
      data: c.req.valid('json'),
    });
    return c.json({ event: serializeFamilyEvent(row) }, 201);
  },
);

familyEventsRouter.patch(
  '/:eventId',
  zValidator('json', updateFamilyEventInputSchema),
  async (c) => {
    const familyId = c.get('familyId');
    const row = await updateEvent({
      familyId,
      eventId: c.req.param('eventId'),
      patch: c.req.valid('json'),
    });
    if (!row) return c.json({ error: 'event_not_found' }, 404);
    return c.json({ event: serializeFamilyEvent(row) });
  },
);

familyEventsRouter.delete('/:eventId', async (c) => {
  const familyId = c.get('familyId');
  const ok = await deleteEvent({ familyId, eventId: c.req.param('eventId') });
  if (!ok) return c.json({ error: 'event_not_found' }, 404);
  return c.body(null, 204);
});

familyEventsRouter.post('/:eventId/restore', async (c) => {
  const familyId = c.get('familyId');
  const row = await restoreEvent({ familyId, eventId: c.req.param('eventId') });
  if (!row) return c.json({ error: 'event_not_found' }, 404);
  return c.json({ event: serializeFamilyEvent(row) });
});
