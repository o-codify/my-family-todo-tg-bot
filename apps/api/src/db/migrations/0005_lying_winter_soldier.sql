CREATE TABLE "task_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"occurrence_id" uuid,
	"user_id" uuid NOT NULL,
	"telegram_file_id" text NOT NULL,
	"telegram_message_id" bigint,
	"telegram_chat_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_photos" ADD CONSTRAINT "task_photos_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_photos" ADD CONSTRAINT "task_photos_occurrence_id_task_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."task_occurrences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_photos" ADD CONSTRAINT "task_photos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_photos_task_idx" ON "task_photos" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_photos_occurrence_idx" ON "task_photos" USING btree ("occurrence_id");--> statement-breakpoint
CREATE INDEX "task_photos_user_idx" ON "task_photos" USING btree ("user_id");