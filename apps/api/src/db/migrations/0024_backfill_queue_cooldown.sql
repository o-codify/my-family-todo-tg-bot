-- Backfill `available_at` on existing queue-task pending rows that
-- were spawned before the cooldown-aware ensureQueuedOccurrence fix.
--
-- Rows from prod looked like:
--   (task_id=<queue>, status='pending', scheduled_date=NULL,
--    available_at=NULL)
-- Calendar's byDate keys null-date pendings to today, so the next
-- rotation showed up on the day the user just completed the chore.
-- The fix in queue-tasks.ts handles all FUTURE spawns; this fills
-- the gap for what's already in the DB.
--
-- Strategy: for each affected pending row, set available_at to
-- created_at + cooldown_days. That gives the closest "what should
-- have been stamped at insert time" approximation. If the cooldown
-- has already elapsed (row is older than cooldown), the resulting
-- timestamp is in the past — effectively meaning "available now",
-- which matches the previous null-equivalent behaviour.
--
-- Idempotent: re-running does nothing because available_at IS NULL
-- shrinks to zero matches after the first pass.
UPDATE "task_occurrences" AS o
SET "available_at" = o."created_at" + (t."cooldown_days" * INTERVAL '1 day')
FROM "tasks" AS t
WHERE o."task_id" = t."id"
  AND t."type" = 'queued'
  AND t."cooldown_days" IS NOT NULL
  AND t."cooldown_days" > 0
  AND o."status" = 'pending'
  AND o."scheduled_date" IS NULL
  AND o."available_at" IS NULL;
