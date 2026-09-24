-- Parcel history: what was sown each year, and which weeds were identified.
--
-- `Parcel.cropType` is a single overwritten string with no year attached, so
-- nothing recorded what a parcel grew before today. The Season -> CropPlan ->
-- Planting chain looks like it would serve and even carries CropPlan.parcelId,
-- but production holds one row of each, all isSampleData, and that parcelId
-- has never been set on a real row.
--
-- Both tables carry the repo's soft-delete + retention shape and the
-- [id, tenantId] cross-tenant row barrier, so a child row can never point at
-- another tenant's parcel.

-- CreateTable
CREATE TABLE "ParcelCropSeason" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "parcelId" TEXT NOT NULL,
    -- HARVEST year. Not derivable from sownAt: an autumn-sown crop is sown in
    -- the preceding calendar year (wheat sown Oct 2025 is the 2026 harvest).
    "year" INTEGER NOT NULL,
    "cropType" TEXT NOT NULL,
    "sownAt" TIMESTAMP(3),
    "harvestedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdByUserId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" TEXT,
    "retentionUntil" TIMESTAMP(3),

    CONSTRAINT "ParcelCropSeason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParcelWeedObservation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "parcelId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    -- Catalogue keys, kept apart from free text so the controlled half stays
    -- reportable across years.
    "weedKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "otherWeeds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdByUserId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" TEXT,
    "retentionUntil" TIMESTAMP(3),

    CONSTRAINT "ParcelWeedObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ParcelCropSeason_id_tenantId_key" ON "ParcelCropSeason"("id", "tenantId");
CREATE INDEX "ParcelCropSeason_tenantId_parcelId_year_idx" ON "ParcelCropSeason"("tenantId", "parcelId", "year");
CREATE INDEX "ParcelCropSeason_tenantId_year_cropType_idx" ON "ParcelCropSeason"("tenantId", "year", "cropType");

-- CreateIndex
CREATE UNIQUE INDEX "ParcelWeedObservation_id_tenantId_key" ON "ParcelWeedObservation"("id", "tenantId");
CREATE INDEX "ParcelWeedObservation_tenantId_parcelId_observedAt_idx" ON "ParcelWeedObservation"("tenantId", "parcelId", "observedAt");

-- AddForeignKey
ALTER TABLE "ParcelCropSeason" ADD CONSTRAINT "ParcelCropSeason_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ParcelCropSeason" ADD CONSTRAINT "ParcelCropSeason_parcelId_tenantId_fkey" FOREIGN KEY ("parcelId", "tenantId") REFERENCES "Parcel"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParcelWeedObservation" ADD CONSTRAINT "ParcelWeedObservation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ParcelWeedObservation" ADD CONSTRAINT "ParcelWeedObservation_parcelId_tenantId_fkey" FOREIGN KEY ("parcelId", "tenantId") REFERENCES "Parcel"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Row-level security.
--
-- Both tables are tenant-scoped, so they take the same four-part policy set
-- every other tenant table here carries: ENABLE + FORCE, a USING policy for
-- reads/updates, a separate WITH CHECK policy for inserts (a USING policy does
-- NOT constrain INSERT), and the superuser bypass that lets migrations and
-- background jobs run as a non-app_user role.
--
-- `tests/guardrails/rls-coverage.test.ts` fails without all four, which is how
-- this was caught — the tables were created and queried correctly, and would
-- have shipped with the composite FK barrier but no row-level one.
-- ═══════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ParcelCropSeason', 'ParcelWeedObservation']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = current_setting(''app.tenant_id'', true)::text)', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_insert ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation_insert ON %I FOR INSERT WITH CHECK ("tenantId" = current_setting(''app.tenant_id'', true)::text)', t);
    EXECUTE format('DROP POLICY IF EXISTS superuser_bypass ON %I', t);
    EXECUTE format('CREATE POLICY superuser_bypass ON %I USING (current_setting(''role'') != ''app_user'')', t);
  END LOOP;
END $$;
