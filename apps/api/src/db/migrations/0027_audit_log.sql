-- Per-family audit log. Records create/update/delete actions on shared
-- entities (tasks first, more later) so the History page can show a
-- timeline of "what happened" beyond just completed occurrences.
--
-- Schema is intentionally wide and string-typed: kind ("task.create"),
-- entity_type ("task"), entity_id (text, not uuid — entity may be
-- hard-deleted later and we still want the log row). entity_title is
-- a denormalised snapshot for display.
--
-- actor_user_id ON DELETE SET NULL so kicking a user keeps the
-- historical record (with anonymous actor) instead of cascading-erasing.
CREATE TABLE IF NOT EXISTS "audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE CASCADE,
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "kind" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" text NOT NULL,
  "entity_title" text,
  "details" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "audit_log_family_created_idx"
  ON "audit_log" ("family_id", "created_at");
CREATE INDEX IF NOT EXISTS "audit_log_entity_idx"
  ON "audit_log" ("entity_type", "entity_id");
