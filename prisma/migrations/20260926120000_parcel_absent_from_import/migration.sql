-- Parcels a spatial import did not match, kept rather than deleted.
--
-- A TIMESTAMP rather than a boolean: "not in the last import" and "not in any
-- import since March" are different facts, and only the first is actionable.
ALTER TABLE "Parcel" ADD COLUMN "absentFromImportAt" TIMESTAMP(3);

-- The flag is only ever read for one location at a time, alongside the
-- soft-delete filter that every parcel read already carries.
CREATE INDEX "Parcel_tenantId_locationId_absentFromImportAt_idx"
    ON "Parcel" ("tenantId", "locationId", "absentFromImportAt");
