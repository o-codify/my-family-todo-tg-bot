-- Backfill: on done occurrences, assignee_id is now strictly the
-- completer. The user rule: "если выполнил другой, то и задача ему
-- переходит — не должно быть логики что ответственный один, а
-- выполнил другой." Queue tasks were the only path where the two
-- could diverge (anyone in the queue can complete out-of-turn);
-- elsewhere the route guard restricted completion to the assignee
-- so they were already equal. This SQL flips any historical rows
-- where they diverged so the data matches the new invariant.
--
-- Same treatment for pending_approval rows: the child completer
-- "owns" their submitted work even before the parent approves.
--
-- Done / pending_approval rows with completed_by IS NULL are left
-- alone — those are either approval-pending without a completer
-- recorded, or legacy rows we can't repair safely. They're a tiny
-- minority and unaffected by this contract.
UPDATE "task_occurrences"
SET "assignee_id" = "completed_by"
WHERE "completed_by" IS NOT NULL
  AND ("status" = 'done' OR "status" = 'pending_approval')
  AND "assignee_id" IS DISTINCT FROM "completed_by";
