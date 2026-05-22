import { sql } from 'drizzle-orm';
import { boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { families } from './families';
import { users } from './users';

export type TemplatePayload = {
  title: string;
  type: 'oneoff' | 'recurring' | 'floating' | 'queued';
  schedule: unknown;
  points?: number;
  photoRequired?: boolean;
  subtasks?: Array<{ title: string }>;
};

export const templates = pgTable('templates', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  familyId: uuid('family_id').references(() => families.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  emoji: text('emoji'),
  payload: jsonb('payload').$type<TemplatePayload>().notNull(),
  isSystem: boolean('is_system').notNull().default(false),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type TemplateRow = typeof templates.$inferSelect;
export type NewTemplateRow = typeof templates.$inferInsert;
