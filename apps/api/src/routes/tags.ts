import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { createTagInputSchema, updateTagInputSchema } from '@family-todo/shared';
import { tgAuth, type AuthVariables } from '../middleware/auth';
import { requireFamily, type FamilyVariables } from '../middleware/family';
import {
  TagServiceError,
  createTag,
  deleteTag,
  listTagsForFamily,
  serializeTag,
  updateTag,
} from '../services/tags';

/**
 * Family-scoped tag CRUD. No special permission gating — any family
 * member can manage tags for now; Phase D's role refactor may add a
 * `tag.manage` permission if abuse becomes a problem.
 */
export const tagsRouter = new Hono<{ Variables: AuthVariables & FamilyVariables }>()
  .use('*', tgAuth)
  .use('*', requireFamily);

tagsRouter.get('/', async (c) => {
  const familyId = c.get('familyId');
  const rows = await listTagsForFamily(familyId);
  return c.json({ tags: rows.map(serializeTag) });
});

tagsRouter.post('/', zValidator('json', createTagInputSchema), async (c) => {
  const familyId = c.get('familyId');
  const data = c.req.valid('json');
  try {
    const row = await createTag({
      familyId,
      name: data.name,
      color: data.color ?? null,
    });
    return c.json({ tag: serializeTag(row) }, 201);
  } catch (err) {
    if (err instanceof TagServiceError) {
      return c.json({ error: err.code }, 409);
    }
    throw err;
  }
});

tagsRouter.patch('/:tagId', zValidator('json', updateTagInputSchema), async (c) => {
  const familyId = c.get('familyId');
  try {
    const row = await updateTag({
      tagId: c.req.param('tagId'),
      familyId,
      patch: c.req.valid('json'),
    });
    if (!row) return c.json({ error: 'tag_not_found' }, 404);
    return c.json({ tag: serializeTag(row) });
  } catch (err) {
    if (err instanceof TagServiceError) {
      return c.json({ error: err.code }, 409);
    }
    throw err;
  }
});

tagsRouter.delete('/:tagId', async (c) => {
  const familyId = c.get('familyId');
  const ok = await deleteTag({ tagId: c.req.param('tagId'), familyId });
  if (!ok) return c.json({ error: 'tag_not_found' }, 404);
  return c.body(null, 204);
});
