CREATE TABLE "meal_plan_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"date" date NOT NULL,
	"slot" text NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"ingredients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "meal_plan_entries" ADD CONSTRAINT "meal_plan_entries_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plan_entries" ADD CONSTRAINT "meal_plan_entries_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meal_plan_family_date_idx" ON "meal_plan_entries" USING btree ("family_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "meal_plan_family_date_slot_alive_idx" ON "meal_plan_entries" USING btree ("family_id","date","slot") WHERE "meal_plan_entries"."deleted_at" IS NULL;