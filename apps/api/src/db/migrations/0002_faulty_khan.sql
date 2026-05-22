DROP INDEX "occurrences_task_date_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "occurrences_task_date_unique" ON "task_occurrences" USING btree ("task_id","scheduled_date");