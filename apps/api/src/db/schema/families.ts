import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

export const families = pgTable('families', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  avatarUrl: text('avatar_url'),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  inviteCode: text('invite_code').notNull().unique(),
  inviteCodeExpiresAt: timestamp('invite_code_expires_at', { withTimezone: true }),
  /**
   * Free-form note pinned to the family home. Visible to every member.
   * Use cases: "В четверг приедут гости", "Не забыть зарядное".
   * Capped at ~280 chars by the API schema — fits comfortably on one
   * sticky-note card and discourages essay-length notes.
   */
  pinnedNote: text('pinned_note'),
  pinnedNoteUpdatedBy: uuid('pinned_note_updated_by').references(() => users.id, {
    onDelete: 'set null',
  }),
  pinnedNoteUpdatedAt: timestamp('pinned_note_updated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type FamilyRow = typeof families.$inferSelect;
export type NewFamilyRow = typeof families.$inferInsert;
