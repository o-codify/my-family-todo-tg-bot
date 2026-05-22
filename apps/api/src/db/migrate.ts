import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql as dsql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, sql } from './client';
import { logger } from '../logger';

/**
 * Locate the migrations directory relative to this script. We support both
 * "dev" (tsx running src/db/migrate.ts → migrations are at ./migrations)
 * and "prod" (compiled dist/db/migrate.js → migrations copied to the same
 * relative location in the Docker image). The MIGRATIONS_DIR env override
 * is for unusual deploy targets.
 */
function resolveMigrationsFolder(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'migrations'),
    // dist/db/migrate.js → src/db/migrations
    join(here, '..', '..', 'src', 'db', 'migrations'),
    // legacy cwd-relative fallback
    './src/db/migrations',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]!;
}

// Stable 64-bit advisory-lock key for migration coordination. The number
// itself is arbitrary — what matters is that every API instance uses the
// same one, so a concurrent boot from a second replica blocks on this lock
// while the first one runs the migrations.
const MIGRATION_LOCK_KEY = 4242424242;

/**
 * Apply pending migrations. Safe to call on every API boot:
 *   - drizzle keeps a `__drizzle_migrations` table and only runs new files
 *   - a Postgres advisory lock prevents concurrent replicas from racing
 *     (the second instance waits, then sees nothing left to do)
 *
 * Throws on failure so the caller can decide whether to crash the boot
 * (the api entry point does — we don't want to serve traffic against a
 * stale schema).
 */
export async function runMigrations(): Promise<void> {
  const migrationsFolder = resolveMigrationsFolder();
  logger.info({ migrationsFolder }, 'Acquiring migration lock...');
  await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
  try {
    logger.info('Running migrations...');
    await migrate(db, { migrationsFolder });
    logger.info('Migrations complete');
  } finally {
    await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    void dsql; // keep import; some drizzle versions tree-shake oddly without it
  }
}

/**
 * CLI entry point. Kept so `node apps/api/dist/db/migrate.js` still works
 * (e.g. for one-off migrations from a Coolify shell).
 */
async function main() {
  await runMigrations();
  await sql.end();
}

// Only run when invoked directly (not when imported by the API boot path).
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((err) => {
    logger.error({ err }, 'Migration failed');
    process.exit(1);
  });
}
