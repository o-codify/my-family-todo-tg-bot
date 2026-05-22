import { defineConfig } from 'drizzle-kit';
import { resolve } from 'node:path';

// drizzle-kit runs this config from the package dir (apps/api), so cwd is reliable.
const envPath = resolve(process.cwd(), '../../.env');
try {
  process.loadEnvFile(envPath);
} catch {
  // .env is optional (in container deploys vars are injected directly)
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
});
