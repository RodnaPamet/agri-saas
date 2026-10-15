-- Rollback for 20261015210000_p6_6_farm_brand_field_visibility.
--
-- Safe for exactly one release, which is the window it exists for: nothing
-- writes these columns yet, so dropping them loses no decision anyone made.
--
-- After the editor's eye toggles ship this becomes DESTRUCTIVE in a direction
-- worth naming precisely. Each column holds a withholding decision, and
-- dropping it re-applies as `false` — "not hidden". That is the UNSAFE
-- direction: a farm that chose to withhold its «За стопанството» paragraph
-- would have that paragraph PUBLISHED again on the next projection refresh,
-- because the text was deliberately kept on the row. Unlike `indexable`,
-- whose default-false rollback merely revokes a choice, this one would
-- disclose content somebody asked to hide.
ALTER TABLE "FarmBrand" DROP COLUMN "hideTagline";
ALTER TABLE "FarmBrand" DROP COLUMN "hideAbout";
ALTER TABLE "FarmBrand" DROP COLUMN "hideOblast";
ALTER TABLE "FarmBrand" DROP COLUMN "hideCrops";
