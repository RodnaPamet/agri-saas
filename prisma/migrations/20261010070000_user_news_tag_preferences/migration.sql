-- #231 step 4 (2026-10-10) — per-person Новини tag preferences.
--
-- One nullable Json column on "User", following `bottomTabOrder`. Additive and
-- backfill-free: every existing row reads as NULL, which means "never chose"
-- and shows the full feed — the behaviour every reader has today.
--
-- NULL and '[]' are deliberately different values and nothing here collapses
-- them. NULL is "never chose", '[]' is "chose nothing"; both show the full
-- feed, but only the first may be prompted. A DEFAULT of '[]' would erase that
-- distinction for every existing user in one statement, which is why this
-- column has no default.
--
-- Hand-authored per repo convention (see
-- `20260614194014_inventory_lot_genealogy`). No inverse in `deploy/rollback/`:
-- additive, and the previous image neither writes nor reads it.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "newsTagPreferences" JSONB;
