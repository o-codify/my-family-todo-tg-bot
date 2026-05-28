-- Family-scoped display-name override, set by the family owner. The user's
-- global first_name/last_name re-sync from Telegram on every auth, so a
-- custom name can't live on `users` (it would be clobbered). Nullable:
-- existing members fall back to their Telegram name in the UI.
ALTER TABLE "family_members" ADD COLUMN "display_name" text;
