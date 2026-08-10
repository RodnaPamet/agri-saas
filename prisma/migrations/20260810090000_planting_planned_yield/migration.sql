-- Planned (expected) yield on Planting, entered by the grower as кг/дка
-- at the UI boundary and stored per hectare (`plannedYieldKgPerHa`) —
-- the same area basis as every other stored figure in this schema
-- (Parcel.areaHa, YieldRecord.areaHa, Planting.areaM2). Nullable ON
-- PURPOSE: an unset expectation is not "expect zero" — same principle
-- as YieldRecord.netTonnesStd being NULL when unmeasured. Purely
-- additive; no backfill, no rollback inverse script needed.
ALTER TABLE "Planting" ADD COLUMN "plannedYieldKgPerHa" DECIMAL(10,2);
