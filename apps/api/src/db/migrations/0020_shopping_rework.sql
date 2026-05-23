-- Shopping rework: drop old single-list semantics, add multi-list with
-- assignee + dueDate + backing task; add catalog linkage on items.
--
-- Per user decision: existing shopping data is dropped (clean start —
-- prod has little/no rows yet). The cascade reaches shopping_items
-- automatically via the FK.

TRUNCATE TABLE "shopping_items" RESTART IDENTITY CASCADE;--> statement-breakpoint
TRUNCATE TABLE "shopping_lists" RESTART IDENTITY CASCADE;--> statement-breakpoint

-- Drop the legacy primary-list marker. Multiple lists per family now.
ALTER TABLE "shopping_lists" DROP COLUMN IF EXISTS "is_primary";--> statement-breakpoint

-- New columns on shopping_lists.
ALTER TABLE "shopping_lists" ADD COLUMN "assignee_user_id" uuid;--> statement-breakpoint
ALTER TABLE "shopping_lists" ADD COLUMN "due_date" date;--> statement-breakpoint
ALTER TABLE "shopping_lists" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "shopping_lists" ADD COLUMN "created_by_user_id" uuid NOT NULL DEFAULT gen_random_uuid();--> statement-breakpoint
-- Drop the placeholder default; new rows must supply createdByUserId.
ALTER TABLE "shopping_lists" ALTER COLUMN "created_by_user_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "shopping_lists" ADD COLUMN "updated_at" timestamp with time zone NOT NULL DEFAULT now();--> statement-breakpoint

ALTER TABLE "shopping_lists" ADD CONSTRAINT "shopping_lists_assignee_user_id_users_id_fk"
  FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "shopping_lists" ADD CONSTRAINT "shopping_lists_created_by_user_id_users_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "shopping_lists_task_idx" ON "shopping_lists" ("task_id");--> statement-breakpoint

-- Catalog linkage on items.
ALTER TABLE "shopping_items" ADD COLUMN "catalog_item_id" uuid;--> statement-breakpoint
ALTER TABLE "shopping_items" ADD CONSTRAINT "shopping_items_catalog_item_id_catalog_items_id_fk"
  FOREIGN KEY ("catalog_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE set null;
