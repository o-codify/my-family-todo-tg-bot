-- Add per-item emoji override so the list can show "🥩 Beef" instead of
-- always falling back to the category's default glyph (🍗 for "meat").
-- Nullable: existing rows stay on the category-derived fallback in the UI.
ALTER TABLE "shopping_items" ADD COLUMN "emoji" text;
