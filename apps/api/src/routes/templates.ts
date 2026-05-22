import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { taskScheduleSchema, taskTypeSchema } from '@family-todo/shared';
import { tgAuth, type AuthVariables } from '../middleware/auth';
import { requireFamily, requirePermission, type FamilyVariables } from '../middleware/family';
import { createTemplate, deleteTemplate, listTemplates, serializeTemplate } from '../services/templates';

const createTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  emoji: z.string().max(16).nullable().optional(),
  payload: z.object({
    title: z.string().min(1).max(200),
    type: taskTypeSchema,
    schedule: taskScheduleSchema,
    points: z.number().int().nonnegative().max(10_000).optional(),
    photoRequired: z.boolean().optional(),
    subtasks: z.array(z.object({ title: z.string().min(1).max(200) })).max(50).optional(),
  }),
});

export const templatesRouter = new Hono<{ Variables: AuthVariables & FamilyVariables }>()
  .use('*', tgAuth)
  .use('*', requireFamily);

templatesRouter.get('/', async (c) => {
  const familyId = c.get('familyId');
  const items = await listTemplates(familyId);
  return c.json({ templates: items.map(serializeTemplate) });
});

templatesRouter.post(
  '/',
  requirePermission('template.manage'),
  zValidator('json', createTemplateSchema),
  async (c) => {
    const user = c.get('user');
    const familyId = c.get('familyId');
    const t = await createTemplate({ familyId, createdBy: user.id, data: c.req.valid('json') });
    return c.json({ template: serializeTemplate(t) }, 201);
  },
);

templatesRouter.delete('/:templateId', requirePermission('template.manage'), async (c) => {
  const familyId = c.get('familyId');
  const ok = await deleteTemplate({ templateId: c.req.param('templateId'), familyId });
  if (!ok) return c.json({ error: 'not_found_or_system' }, 404);
  return c.body(null, 204);
});
