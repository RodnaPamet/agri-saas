-- Asset: maintenance history, structured location, and a depreciation
-- basis for the machinery cost the register was already collecting.
--
-- Three independent gaps on the same model:
--   1. `AssetStatus.IN_MAINTENANCE` was a status with nothing behind it
--      — no record of what was done, when, at what meter reading, or
--      what it cost.
--   2. `Asset.location` was free text while the app models geography
--      properly via Location/Parcel, so "which machines are at the
--      Dobrich yard" was a string match.
--   3. `purchaseCost` / `purchaseDate` were captured and read back and
--      touched by no calculation. A money column no arithmetic reads is
--      how `stockCost` earned its distrust; this gives them a basis.

-- ── 1. Enums ───────────────────────────────────────────────────────────
DO $$ BEGIN
    CREATE TYPE "AssetMaintenanceKind" AS ENUM ('SERVICE', 'REPAIR', 'INSPECTION', 'BREAKDOWN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE "DepreciationMethod" AS ENUM ('NONE', 'STRAIGHT_LINE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. Asset columns ───────────────────────────────────────────────────
-- `locationId` is nullable and the free-text `location` column is
-- RETAINED: it holds unstructured detail ("north shed, back bay") that a
-- Location row does not model, and dropping it would discard what farms
-- have already typed.
ALTER TABLE "Asset" ADD COLUMN IF NOT EXISTS "locationId" TEXT;
-- Useful life is the straight-line denominator. NULL means "not
-- depreciated" — the rollup reports such an asset as UNALLOCATED rather
-- than charging zero, because a silent zero reads as "this machine was
-- free".
ALTER TABLE "Asset" ADD COLUMN IF NOT EXISTS "usefulLifeYears" INTEGER;

-- Composite FK: the same [id, tenantId] barrier Parcel uses, so a machine
-- can never reference another tenant's yard.
ALTER TABLE "Asset" DROP CONSTRAINT IF EXISTS "Asset_locationId_tenantId_fkey";
ALTER TABLE "Asset"
    ADD CONSTRAINT "Asset_locationId_tenantId_fkey"
    FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "Asset_tenantId_locationId_idx" ON "Asset"("tenantId", "locationId");

-- ── 3. Tenant depreciation method ──────────────────────────────────────
-- Defaults to NONE so no existing tenant's /costs figures move the day
-- this ships. Depreciation appears only once a farm opts in AND sets a
-- useful life on its machines.
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "depreciationMethod" "DepreciationMethod" NOT NULL DEFAULT 'NONE';

-- ── 4. AssetMaintenance ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "AssetMaintenance" (
    "id"              TEXT NOT NULL,
    "tenantId"        TEXT NOT NULL,
    "assetId"         TEXT NOT NULL,
    "kind"            "AssetMaintenanceKind" NOT NULL,
    "openedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt"        TIMESTAMP(3),
    "meterAtService"  DECIMAL(12,1),
    "description"     TEXT,
    "cost"            DECIMAL(12,2),
    "vendorId"        TEXT,
    "nextDueAt"       TIMESTAMP(3),
    "nextDueMeter"    DECIMAL(12,1),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    "createdByUserId" TEXT,
    CONSTRAINT "AssetMaintenance_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AssetMaintenance" DROP CONSTRAINT IF EXISTS "AssetMaintenance_tenantId_fkey";
ALTER TABLE "AssetMaintenance"
    ADD CONSTRAINT "AssetMaintenance_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Cascade: maintenance history is meaningless without its machine, and
-- Asset deletion is already a deliberate, guarded operation.
ALTER TABLE "AssetMaintenance" DROP CONSTRAINT IF EXISTS "AssetMaintenance_assetId_fkey";
ALTER TABLE "AssetMaintenance"
    ADD CONSTRAINT "AssetMaintenance_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AssetMaintenance" DROP CONSTRAINT IF EXISTS "AssetMaintenance_vendorId_fkey";
ALTER TABLE "AssetMaintenance"
    ADD CONSTRAINT "AssetMaintenance_vendorId_fkey"
    FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AssetMaintenance" DROP CONSTRAINT IF EXISTS "AssetMaintenance_createdByUserId_fkey";
ALTER TABLE "AssetMaintenance"
    ADD CONSTRAINT "AssetMaintenance_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "AssetMaintenance_tenantId_assetId_idx" ON "AssetMaintenance"("tenantId", "assetId");
CREATE INDEX IF NOT EXISTS "AssetMaintenance_tenantId_assetId_openedAt_idx" ON "AssetMaintenance"("tenantId", "assetId", "openedAt");
CREATE INDEX IF NOT EXISTS "AssetMaintenance_tenantId_closedAt_idx" ON "AssetMaintenance"("tenantId", "closedAt");
CREATE INDEX IF NOT EXISTS "AssetMaintenance_tenantId_vendorId_idx" ON "AssetMaintenance"("tenantId", "vendorId");

-- ── 5. Row Level Security ──────────────────────────────────────────────
ALTER TABLE "AssetMaintenance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssetMaintenance" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AssetMaintenance";
CREATE POLICY tenant_isolation ON "AssetMaintenance"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AssetMaintenance";
CREATE POLICY tenant_isolation_insert ON "AssetMaintenance"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AssetMaintenance";
CREATE POLICY superuser_bypass ON "AssetMaintenance"
    USING (current_setting('role') != 'app_user');
