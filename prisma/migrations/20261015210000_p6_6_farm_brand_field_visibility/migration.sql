-- P6.6 (#1815) — per-field visibility for the public farm profile.
--
-- One flag per OPTIONAL published field. The editor's eye toggle will set
-- these and `projectFarmBrand` will omit a hidden field from
-- `PublicFarmProfile`, while the text itself stays on `FarmBrand`.
--
-- Hiding is not deleting. All four fields are nullable, so until now the only
-- way to withhold «За стопанството» was to delete the paragraph — and to show
-- it again, retype it. That is a destructive action behind an icon meaning
-- "shown/hidden", which is the defect the owner's ruling corrects.
--
-- `handle` and `displayName` get no flag: both are publication preconditions,
-- so a published farm cannot withhold them. `indexable` gets none: it is a
-- decision about crawlers rather than a field a visitor reads.
--
-- Defaults to false — "not hidden" — which is the answer every existing row
-- already gives implicitly, so no farm's public page changes. Plain additive:
-- no previous image can break on it, and nothing writes these yet.
ALTER TABLE "FarmBrand" ADD COLUMN "hideTagline" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "FarmBrand" ADD COLUMN "hideAbout"   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "FarmBrand" ADD COLUMN "hideOblast"  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "FarmBrand" ADD COLUMN "hideCrops"   BOOLEAN NOT NULL DEFAULT false;
