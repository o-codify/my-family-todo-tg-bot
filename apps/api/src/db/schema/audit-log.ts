import { sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { families } from './families';
import { users } from './users';

/**
 * Generic per-family audit log.
 *
 * Records actions a member performs that affect shared family state:
 * task created / updated / deleted, shopping list created, family
 * event added/removed, etc. The History page reads this log alongside
 * completed occurrences and granted redemptions to give a single
 * timeline of "what happened in the family".
 *
 * Schema is deliberately wide and string-typed so we can add new
 * `kind`s without a migration each time:
 *
 *   - `kind`         — dot-namespaced action key, e.g. "task.create",
 *                      "task.update", "task.delete", "shopping.list.create".
 *                      Lowercase, no spaces. The frontend maps these to
 *                      i18n strings.
 *   - `entityType`   — coarse object class, e.g. "task", "shopping_list".
 *                      Useful for filtering ("show me only task events").
 *   - `entityId`     — the affected row's id. Stored as text (not uuid)
 *                      so we don't need an FK — entities may be hard
 *                      deleted later and we still want the log row.
 *   - `entityTitle`  — denormalised snapshot of the entity's display
 *                      label at the moment of the action. Cheap, lets
 *                      the History row render even if the entity is
 *                      gone or renamed.
 *   - `details`      — optional structured payload. For `task.update`
 *                      we stash a small diff `{ changedFields: [...] }`
 *                      so the History row can summarise "title, points".
 *                      Loose shape on purpose — adding fields later
 *                      doesn't need a migration.
 *
 * `actorUserId` is the user who performed the action. `onDelete:
 * set null` so removing a user (kick + cascade) preserves the
 * historic record with an anonymous "—" actor instead of erasing it.
 *
 * Index on (family_id, created_at desc) so the History query — "give
 * me everything for this family newest-first" — uses an index scan.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    kind: text('kind').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    entityTitle: text('entity_title'),
    details: jsonb('details').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    familyCreatedIdx: index('audit_log_family_created_idx').on(
      table.familyId,
      table.createdAt,
    ),
    entityIdx: index('audit_log_entity_idx').on(
      table.entityType,
      table.entityId,
    ),
  }),
);

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
