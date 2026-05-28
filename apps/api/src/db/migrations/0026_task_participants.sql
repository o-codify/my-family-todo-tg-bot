-- Shared tasks: additional participants beyond the single responsible
-- assignee. They see the task and earn its points on completion. Does not
-- include the assignee (implicitly a participant). Null = solo task.
ALTER TABLE "tasks" ADD COLUMN "participant_ids" uuid[];
