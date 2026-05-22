import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env';
import * as schema from './schema';

export const sql = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
});

export const db = drizzle(sql, { schema, casing: 'snake_case' });

export type Db = typeof db;
