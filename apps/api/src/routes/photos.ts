import { Hono } from 'hono';
import { tgAuth, type AuthVariables } from '../middleware/auth';
import { requireFamily, type FamilyVariables } from '../middleware/family';
import { env } from '../env';
import {
  PhotoServiceError,
  deletePhoto,
  getPhotoById,
  getPhotoDownloadUrl,
  listPhotosForFamily,
  listPhotosForOccurrence,
  listPhotosForTask,
  sendTaskPhoto,
  serializePhoto,
  userOwnsPhoto,
} from '../services/photos';
import { getOccurrenceInFamily } from '../services/occurrence-actions';
import { getTaskInFamily } from '../services/tasks';
import { logger } from '../logger';

/**
 * REST endpoints for the Telegram-native photo flow. Photos themselves live
 * in Telegram; this router only manages the metadata + acts as a thin proxy
 * to `getFile` for display URLs.
 *
 * Routes (all family-scoped):
 *   POST   /occurrences/:occurrenceId/photos      — upload (multipart)
 *   GET    /tasks/:taskId/photos                  — list by task
 *   GET    /occurrences/:occurrenceId/photos      — list by occurrence
 *   GET    /photos/:photoId/url                   — fresh Telegram CDN URL
 *   DELETE /photos/:photoId                       — remove (DB + bot message)
 */
export const photosRouter = new Hono<{ Variables: AuthVariables & FamilyVariables }>()
  .use('*', tgAuth)
  .use('*', requireFamily);

const ALLOWED_MIME = new Set(
  env.PHOTO_ALLOWED_MIME.split(',').map((s) => s.trim().toLowerCase()),
);

photosRouter.post('/occurrences/:occurrenceId/photos', async (c) => {
  const user = c.get('user');
  const familyId = c.get('familyId');
  const occurrenceId = c.req.param('occurrenceId');

  // Synth ids from the Mini App's "Когда-нибудь" floating rollup look like
  // `floating:<taskId>`. In that case there's no real occurrence yet, but
  // the user is uploading "as part of completing this floating task". We
  // accept it and attach the photo to the task with occurrenceId=null —
  // the next completion will bind them retroactively.
  let occurrenceForRow: { id: string } | null = null;
  let taskId: string;
  if (occurrenceId.startsWith('floating:')) {
    taskId = occurrenceId.slice('floating:'.length);
  } else {
    const occ = await getOccurrenceInFamily(occurrenceId, familyId);
    if (!occ) return c.json({ error: 'occurrence_not_found' }, 404);
    occurrenceForRow = { id: occ.id };
    taskId = occ.taskId;
  }

  const task = await getTaskInFamily(taskId, familyId);
  if (!task) return c.json({ error: 'task_not_found' }, 404);

  // Hono's parseBody gives us the multipart file directly.
  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.json({ error: 'invalid_form' }, 400);
  }
  const file = body['file'];
  if (!(file instanceof File)) {
    return c.json({ error: 'missing_file' }, 400);
  }
  if (file.size > env.PHOTO_MAX_SIZE_BYTES) {
    return c.json({ error: 'file_too_large', limit: env.PHOTO_MAX_SIZE_BYTES }, 413);
  }
  const mime = (file.type || '').toLowerCase();
  if (mime && !ALLOWED_MIME.has(mime)) {
    return c.json({ error: 'unsupported_type', allowed: [...ALLOWED_MIME] }, 415);
  }

  const buf = new Uint8Array(await file.arrayBuffer());
  try {
    const row = await sendTaskPhoto({
      task,
      occurrenceId: occurrenceForRow?.id ?? null,
      userId: user.id,
      fileBytes: buf,
      fileName: file.name || 'photo.jpg',
      mimeType: mime || 'image/jpeg',
    });
    return c.json({ photo: serializePhoto(row) }, 201);
  } catch (err) {
    if (err instanceof PhotoServiceError) {
      const status = err.code === 'limit_reached' ? 409 : 502;
      return c.json({ error: err.code, message: err.message }, status);
    }
    logger.error({ err }, 'sendTaskPhoto failed');
    throw err;
  }
});

/**
 * Family-wide photo gallery (used by MemberProfile's "Фото-отчёты").
 * Query params:
 *   userId?     — narrow to one member's photos
 *   limit?      — page size (1..200, default 60)
 *   before?     — ISO timestamp cursor for keyset pagination (createdAt < before)
 */
photosRouter.get('/photos', async (c) => {
  const familyId = c.get('familyId');
  const url = new URL(c.req.url);
  const userIdParam = url.searchParams.get('userId') ?? undefined;
  const limitParam = url.searchParams.get('limit');
  const beforeIso = url.searchParams.get('before') ?? undefined;
  const rows = await listPhotosForFamily({
    familyId,
    userId: userIdParam,
    limit: limitParam ? Number(limitParam) : undefined,
    beforeIso,
  });
  return c.json({ photos: rows.map(serializePhoto) });
});

photosRouter.get('/tasks/:taskId/photos', async (c) => {
  const familyId = c.get('familyId');
  const taskId = c.req.param('taskId');
  const task = await getTaskInFamily(taskId, familyId);
  if (!task) return c.json({ error: 'task_not_found' }, 404);
  const rows = await listPhotosForTask(taskId);
  return c.json({ photos: rows.map(serializePhoto) });
});

photosRouter.get('/occurrences/:occurrenceId/photos', async (c) => {
  const familyId = c.get('familyId');
  const occurrenceId = c.req.param('occurrenceId');
  if (occurrenceId.startsWith('floating:')) {
    // No occurrence yet → nothing attached to it. Return empty.
    return c.json({ photos: [] });
  }
  const occ = await getOccurrenceInFamily(occurrenceId, familyId);
  if (!occ) return c.json({ error: 'occurrence_not_found' }, 404);
  const rows = await listPhotosForOccurrence(occurrenceId);
  return c.json({ photos: rows.map(serializePhoto) });
});

photosRouter.get('/photos/:photoId/url', async (c) => {
  const familyId = c.get('familyId');
  const photoId = c.req.param('photoId');
  const photo = await getPhotoById(photoId);
  if (!photo) return c.json({ error: 'photo_not_found' }, 404);
  // Family-scope guard: the photo's task must live in this family.
  const task = await getTaskInFamily(photo.taskId, familyId);
  if (!task) return c.json({ error: 'photo_not_found' }, 404);
  try {
    const url = await getPhotoDownloadUrl(photo);
    // Telegram file URLs expire ≈ 1h. Tell the client it can cache briefly.
    return c.json({ url, ttlSeconds: 3000 });
  } catch (err) {
    if (err instanceof PhotoServiceError) {
      return c.json({ error: err.code }, 502);
    }
    throw err;
  }
});

photosRouter.delete('/photos/:photoId', async (c) => {
  const user = c.get('user');
  const familyId = c.get('familyId');
  const photoId = c.req.param('photoId');
  const photo = await getPhotoById(photoId);
  if (!photo) return c.json({ error: 'photo_not_found' }, 404);

  // Photo owner can always delete; otherwise require role permission.
  if (photo.userId !== user.id) {
    const perms = c.get('permissions');
    if (!perms.includes('task.delete.any')) {
      return c.json({ error: 'forbidden' }, 403);
    }
  }

  // Family-scope guard.
  const task = await getTaskInFamily(photo.taskId, familyId);
  if (!task) return c.json({ error: 'photo_not_found' }, 404);
  void userOwnsPhoto; // kept for symmetry with future audit logging

  await deletePhoto(photoId);
  return c.body(null, 204);
});
