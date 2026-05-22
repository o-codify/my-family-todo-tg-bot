import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

async function main() {
  const migrationsFolder = resolveMigrationsFolder();
  logger.info({ migrationsFolder }, 'Running migrations...');
  await migrate(db, { migrationsFolder });
  logger.info('Migrations complete');
  await sql.end();
}

main().catch((err) => {
  logger.error({ err }, 'Migration failed');
  process.exit(1);
});
