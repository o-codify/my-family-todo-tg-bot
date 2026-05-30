import { Hono } from 'hono';
import { tgAuth, type AuthVariables } from '../middleware/auth';
import { requireFamily, type FamilyVariables } from '../middleware/family';
import { listAuditEvents, serializeAuditEvent } from '../services/audit-log';

/**
 * GET /api/v1/families/:familyId/audit-log?from=ISO&to=ISO&limit=N
 *
 * Returns the family's audit events (task create/update/delete and
 * other future entity events) newest first. Driven by the History
 * page, which merges these with the completed-occurrences and
 * granted-redemptions feeds into a single timeline.
 *
 * Open to any family member: there's no permission gate beyond
 * "you must be in the family" — the data is shared family activity.
 */
export const auditLogRouter = new Hono<{
  Variables: AuthVariables & FamilyVariables;
}>()
  .use('*', tgAuth)
  .use('*', requireFamily);

auditLogRouter.get('/', async (c) => {
  const familyId = c.get('familyId');
  const fromParam = c.req.query('from');
  const toParam = c.req.query('to');
  const limitParam = c.req.query('limit');
  const from = fromParam ? new Date(fromParam) : undefined;
  const to = toParam ? new Date(toParam) : undefined;
  // Cap at 1000 to keep the response bounded even if a client asks
  // for more; default 500 covers a busy family for ~3 months.
  const requested = limitParam ? parseInt(limitParam, 10) : 500;
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(requested, 1), 1000)
    : 500;
  const events = await listAuditEvents({ familyId, from, to, limit });
  return c.json({ events: events.map(serializeAuditEvent) });
});
