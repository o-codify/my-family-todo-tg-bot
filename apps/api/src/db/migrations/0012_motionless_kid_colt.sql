CREATE TABLE "family_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"emoji" text,
	"month" integer NOT NULL,
	"day" integer NOT NULL,
	"year" integer,
	"member_user_id" uuid,
	"notify_days_before" jsonb DEFAULT '[0,1,7]'::jsonb NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "family_events" ADD CONSTRAINT "family_events_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_events" ADD CONSTRAINT "family_events_member_user_id_users_id_fk" FOREIGN KEY ("member_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_events" ADD CONSTRAINT "family_events_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "family_events_family_idx" ON "family_events" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "family_events_member_idx" ON "family_events" USING btree ("member_user_id");