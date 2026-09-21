-- "Try it with sample data" could not demo the grain calculator.
--
-- `loadSampleData` builds a Location, Parcels, an InventoryLot and journal
-- entries, all tagged `isSampleData` so `clearSampleData` can find and
-- soft-delete them. It did NOT build the planning chain, and the calculator
-- reports nothing without one: it reads Plantings, resolves their CropPlan's
-- CropType to a canonical commodity, and prices that against the global
-- market series.
--
-- Without these columns the chain could still be created, but the rows would
-- be indistinguishable from a farmer's real planning and `clearSampleData`
-- would have no way to find them — sample data you cannot clear, in the
-- tables where "is this real?" matters most.
--
-- All four models already carry `deletedAt`, so the clear path stays a soft
-- delete exactly like every other sample row. Additive, defaulted, and
-- backfill-free: every existing row is real planning and `false` is correct
-- for all of them.
ALTER TABLE "CropType" ADD COLUMN "isSampleData" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Season"   ADD COLUMN "isSampleData" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CropPlan" ADD COLUMN "isSampleData" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Planting" ADD COLUMN "isSampleData" BOOLEAN NOT NULL DEFAULT false;
