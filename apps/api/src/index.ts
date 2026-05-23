import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { sql as dbSql, db } from './db/client';
import { runMigrations } from './db/migrate';
import { env } from './env';
import { logger } from './logger';
import { catalogRouter } from './routes/catalog';
import { familiesRouter } from './routes/families';
import { internalRouter } from './routes/internal';
import { meRouter } from './routes/me';
import { occurrencesRouter } from './routes/occurrences';
import { photosRouter } from './routes/photos';
import { badgesRouter } from './routes/badges';
import { shoppingRouter } from './routes/shopping';
import { tagsRouter } from './routes/tags';
import { tasksRouter } from './routes/tasks';
import { templatesRouter } from './routes/templates';
import { rewardsRouter } from './routes/rewards';
import { transfersRouter } from './routes/transfers';
import { rolesRouter } from './routes/roles';
import { statsRouter } from './routes/stats';
import { eventsRouter } from './routes/events';
import { familyEventsRouter } from './routes/family-events';
import { closeRealtime } from './realtime/pubsub';
import { closeQueue } from './queue';
import { hydrateDigestSchedulers, startNotificationsWorker, stopNotificationsWorker } from './queue/worker';

const app = new Hono();

app.use('*', honoLogger((msg) => logger.debug(msg)));

const corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
app.use(
  '*',
  cors({
    /**
     * CORS resolver:
     *  - In development: mirror any request origin (including LAN IPs like
     *    http://192.168.x.x:5173 when testing from a phone on the same Wi-Fi).
     *  - In production: only the configured whitelist.
     * Browsers reject `Origin: *` together with `credentials: true`, so we
     * always echo the requesting origin when it's allowed.
     */
    origin: (origin) => {
      if (!origin) return '*';
      if (env.NODE_ENV !== 'production') return origin;
      if (corsOrigins.length === 0) return origin;
      return corsOrigins.includes(origin) ? origin : '';
    },
    credentials: true,
  }),
);

/**
 * Last-ditch error handler. Without this, any unhandled throw inside a route
 * (DB failure, undefined access, etc.) becomes a generic Hono 500 with the
 * literal "Internal Server Error" string — useless when diagnosing what the
 * user actually saw. We log the full error + path here and surface a stable
 * error code in the response so the frontend can show something better than
 * "API 500 /some/url".
 */
app.onError((err, c) => {
  logger.error(
    {
      err: { name: err.name, message: err.message, stack: err.stack },
      path: c.req.path,
      method: c.req.method,
    },
    'unhandled route error',
  );
  return c.json(
    {
      error: 'internal_server_error',
      message: env.NODE_ENV === 'production' ? 'Internal Server Error' : err.message,
    },
    500,
  );
});

app.get('/health', async (c) => {
  let dbStatus: 'ok' | 'error' = 'ok';
  try {
    await dbSql`select 1`;
  } catch {
    dbStatus = 'error';
  }
  return c.json({
    status: dbStatus === 'ok' ? 'ok' : 'degraded',
    db: dbStatus,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (c) => c.json({ name: 'family-todo-api', version: '0.0.0' }));

app.route('/api/v1/me', meRouter);
app.route('/api/v1/families', familiesRouter);
app.route('/api/v1/families/:familyId/tasks', tasksRouter);
app.route('/api/v1/families/:familyId/occurrences', occurrencesRouter);
app.route('/api/v1/families/:familyId/catalog', catalogRouter);
app.route('/api/v1/families/:familyId/templates', templatesRouter);
app.route('/api/v1/families/:familyId/rewards', rewardsRouter);
app.route('/api/v1/families/:familyId/transfers', transfersRouter);
app.route('/api/v1/families/:familyId/roles', rolesRouter);
app.route('/api/v1/families/:familyId/stats', statsRouter);
app.route('/api/v1/families/:familyId/tags', tagsRouter);
app.route('/api/v1/families/:familyId/badges', badgesRouter);
app.route('/api/v1/families/:familyId/shopping', shoppingRouter);
app.route('/api/v1/families/:familyId/family-events', familyEventsRouter);
// SSE stream — auth via query string (EventSource can't set headers).
app.route('/api/v1/families', eventsRouter);
// Photo routes share the family-id scope but expose three distinct shapes
// (tasks/:id/photos, occurrences/:id/photos, photos/:id) so we mount under
// the family root rather than a single sub-prefix.
app.route('/api/v1/families/:familyId', photosRouter);
// Mounted under /api so reverse proxies that only route `/api/*` to the
// api container (typical when api + miniapp share one domain) still
// reach internal endpoints. Auth is still gated by INTERNAL_SERVICE_TOKEN
// via serviceAuth middleware — the prefix change doesn't weaken anything.
app.route('/api/internal/v1', internalRouter);

/**
 * Boot sequence:
 *   1. Run pending DB migrations (idempotent, advisory-locked) — we never
 *      want to start serving traffic against a stale schema.
 *   2. Bind the HTTP server.
 *   3. Start the BullMQ worker + hydrate digest schedulers.
 *
 * If migrations fail we crash the process — Docker / Coolify will surface
 * the error in the logs and restart-loop it until the operator fixes the
 * database connection. Half-migrated DBs are not worth serving.
 */
async function main() {
  try {
    await runMigrations();
  } catch (err) {
    logger.error({ err }, 'Migrations failed — refusing to start API');
    process.exit(1);
  }

  const server = serve({
    fetch: app.fetch,
    port: env.API_PORT,
    hostname: env.API_HOST,
  });

  logger.info(
    { port: env.API_PORT, host: env.API_HOST, env: env.NODE_ENV },
    `API listening on http://${env.API_HOST}:${env.API_PORT}`,
  );

  // Boot the BullMQ worker in-process. For now we co-locate it with the API;
  // a dedicated apps/worker process is cleaner at scale. Hydration after boot
  // makes sure every user with digestEnabled has a repeatable job even if
  // Redis lost state.
  startNotificationsWorker();
  void hydrateDigestSchedulers().catch((err) =>
    logger.warn({ err }, 'failed to hydrate digest schedulers'),
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    server.close();
    await stopNotificationsWorker();
    await closeQueue();
    await closeRealtime();
    await dbSql.end();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void db;
main().catch((err) => {
  logger.error({ err }, 'Fatal boot error');
  process.exit(1);
});
