ALTER TABLE "families" ADD COLUMN "pinned_note" text;--> statement-breakpoint
ALTER TABLE "families" ADD COLUMN "pinned_note_updated_by" uuid;--> statement-breakpoint
ALTER TABLE "families" ADD COLUMN "pinned_note_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "families" ADD CONSTRAINT "families_pinned_note_updated_by_users_id_fk" FOREIGN KEY ("pinned_note_updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;