ALTER TYPE "public"."occurrence_status" ADD VALUE 'pending_approval';--> statement-breakpoint
ALTER TABLE "task_occurrences" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_occurrences" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "task_occurrences" ADD COLUMN "rejected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_occurrences" ADD COLUMN "rejected_by" uuid;--> statement-breakpoint
ALTER TABLE "task_occurrences" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "requires_approval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "task_occurrences" ADD CONSTRAINT "task_occurrences_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_occurrences" ADD CONSTRAINT "task_occurrences_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;