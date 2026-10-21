-- #2077 — the БАБХ register of approved plant-protection products, as a
-- dated manual import.
--
-- ## Why an upload and not a fetch
--
-- Owner's ruling 2026-10-20. We own neither the register's format nor its
-- URL, so a scheduled parser against them can break overnight — and the
-- failure mode is not an error, it is WRONG DOSES rendered identically to
-- right ones. A manual upload makes a refresh a deliberate act with a known
-- date, which turns staleness from silent into visible. On a figure a farmer
-- may put on a regulated document, that is the property worth buying.
--
-- ## An import is a SNAPSHOT
--
-- The read uses the latest import only. Older ones are kept for provenance —
-- a suggestion carries the date it came from — but are never merged. Merging
-- would let a row withdrawn in the newest file still match from an older one,
-- which is the single worst outcome this table can produce.
--
-- ## Not tenant-scoped
--
-- The register is national: identical for every farm. Same decision as
-- `MarketPriceSeries`, and classified the same way in `rls-coverage`.
--
-- ## `importedById` is an opaque id, not a foreign key
--
-- GDPR erasure deletes `User` rows. A relation would either cascade a
-- national regulatory register away with an operator's account, or need
-- registering as an exception in `eraseAccount`. Who uploaded a public
-- register is provenance, not personal data about them, and the register must
-- outlive them.
CREATE TABLE "PppRegisterImport" (
    "id" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "importedById" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "entryCount" INTEGER NOT NULL,
    -- Stamped LAST. The read ignores a NULL, so a half-written import cannot
    -- become the live register — see the schema comment.
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "PppRegisterImport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PppRegisterImport_importedAt_idx" ON "PppRegisterImport"("importedAt");

CREATE TABLE "PppRegisterEntry" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "crop" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "pppRegistrationNo" TEXT,
    "pests" TEXT[],
    "doseMin" DECIMAL(14,4),
    "doseMax" DECIMAL(14,4),
    "doseUnit" TEXT,
    "quarantinePeriodDays" INTEGER,
    "withdrawn" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PppRegisterEntry_pkey" PRIMARY KEY ("id")
);

-- The read's own shape: newest import, then crop + product, with the
-- registration number as the preferred key.
CREATE INDEX "PppRegisterEntry_importId_crop_productName_idx" ON "PppRegisterEntry"("importId", "crop", "productName");
CREATE INDEX "PppRegisterEntry_importId_pppRegistrationNo_idx" ON "PppRegisterEntry"("importId", "pppRegistrationNo");

ALTER TABLE "PppRegisterEntry" ADD CONSTRAINT "PppRegisterEntry_importId_fkey"
    FOREIGN KEY ("importId") REFERENCES "PppRegisterImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
