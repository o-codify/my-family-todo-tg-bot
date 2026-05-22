CREATE TYPE "public"."occurrence_status" AS ENUM('pending', 'done', 'skipped', 'expired');--> statement-breakpoint
CREATE TYPE "public"."task_type" AS ENUM('oneoff', 'recurring', 'floating', 'queued');--> statement-breakpoint
CREATE TABLE "task_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"scheduled_date" date,
	"scheduled_time" time,
	"assignee_id" uuid,
	"status" "occurrence_status" DEFAULT 'pending' NOT NULL,
	"subtasks" jsonb,
	"available_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"photo_ids" uuid[],
	"points_awarded" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"type" "task_type" NOT NULL,
	"schedule" jsonb NOT NULL,
	"assignee_id" uuid,
	"queue_user_ids" uuid[],
	"deadline_at" timestamp with time zone,
	"points" integer DEFAULT 0 NOT NULL,
	"photo_required" boolean DEFAULT false NOT NULL,
	"single_shot" boolean DEFAULT false NOT NULL,
	"cooldown_days" integer,
	"subtasks_template" jsonb,
	"created_by" uuid NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_occurrences" ADD CONSTRAINT "task_occurrences_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_occurrences" ADD CONSTRAINT "task_occurrences_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_occurrences" ADD CONSTRAINT "task_occurrences_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "occurrences_task_date_unique" ON "task_occurrences" USING btree ("task_id","scheduled_date") WHERE "task_occurrences"."scheduled_date" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "occurrences_assignee_date_idx" ON "task_occurrences" USING btree ("assignee_id","scheduled_date");--> statement-breakpoint
CREATE INDEX "occurrences_task_status_idx" ON "task_occurrences" USING btree ("task_id","status");--> statement-breakpoint
CREATE INDEX "tasks_family_archived_idx" ON "tasks" USING btree ("family_id","archived_at");--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("assignee_id");