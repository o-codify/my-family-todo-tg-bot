-- Drop duplicate dateless pending occurrences per task.
--
-- Legacy state from the pre-fix completeFloatingTask path: each
-- completion + reopen could insert another `(scheduled_date IS NULL,
-- status='pending')` row for the same task, while the previous one
-- was still hanging around. Over time tasks accumulated 2+ dateless
-- pendings each, which then showed up as duplicate events in the
-- Telegram digest, duplicate dots in the calendar, etc.
--
-- The current code paths (completeFloatingTask assignee inherit,
-- uncompleteOccurrence sibling cleanup, ensureQueuedOccurrence dedup)
-- prevent new dupes. This one-off cleans the rows already in the DB.
--
-- Strategy: per task_id, keep the OLDEST pending dateless row (by
-- created_at, then id as tiebreaker), drop the rest. Done / skipped /
-- expired rows are untouched.
DELETE FROM "task_occurrences" t1
WHERE t1."scheduled_date" IS NULL
  AND t1."status" = 'pending'
  AND EXISTS (
    SELECT 1 FROM "task_occurrences" t2
    WHERE t2."task_id" = t1."task_id"
      AND t2."scheduled_date" IS NULL
      AND t2."status" = 'pending'
      AND (
        t2."created_at" < t1."created_at"
        OR (t2."created_at" = t1."created_at" AND t2."id" < t1."id")
      )
  );
