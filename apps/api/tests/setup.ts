import { resolve } from 'node:path';

// Load .env from monorepo root so tests use the same Postgres/Redis/MinIO as dev.
try {
  process.loadEnvFile(resolve(import.meta.dirname, '../../../.env'));
} catch {
  // .env may already be loaded via --env-file
}
