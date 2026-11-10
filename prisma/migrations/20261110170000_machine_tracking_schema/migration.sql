-- #2948 stage 1 — GPS machinery tracking: tables, RLS and indexes only.
--
-- NO listener, route, usecase, job or UI. The standing rule P5/P8/P9 all
-- follow: tables ship one release ahead of the code that writes them, so a
-- rollback never leaves an image querying objects that are not there.
--
-- PURELY ADDITIVE — five new tables plus one new unique index on "Task". No
-- DROP, no RENAME, no rewrite of persisted data, so `destructive-migration-
-- has-inverse` requires no `.down.sql`: the previous image queries none of
-- these objects and is unaffected by their existence.
--
-- The body below, down to the FOREIGN KEY block, is `prisma migrate diff`
-- output, unedited. Everything after the marked line is hand-written because
-- Prisma cannot express it — the same reason the RLS policies on every other
-- tenant table are hand-written.

-- CreateTable
CREATE TABLE "MachineTracker" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "imei" TEXT NOT NULL,
    "label" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "driversInformedAt" TIMESTAMP(3) NOT NULL,
    "driversInformedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MachineTracker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MachinePosition" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "trackerId" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "lat" DECIMAL(10,7) NOT NULL,
    "lon" DECIMAL(10,7) NOT NULL,
    "speedKph" DECIMAL(5,1),
    "headingDeg" INTEGER,
    "ignition" BOOLEAN,
    "satellites" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MachinePosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkedParcel" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "parcelId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "minutesWorked" INTEGER NOT NULL,
    "areaHa" DECIMAL(10,3),
    "confidence" DECIMAL(3,2),
    "derivedFrom" TEXT NOT NULL,
    "derivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkedParcel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskAsset" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MachineGeofenceState" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "outsideSince" TIMESTAMP(3),
    "alertedAt" TIMESTAMP(3),
    "lastEvaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MachineGeofenceState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MachineTracker_imei_key" ON "MachineTracker"("imei");

-- CreateIndex
CREATE INDEX "MachineTracker_tenantId_idx" ON "MachineTracker"("tenantId");

-- CreateIndex
CREATE INDEX "MachineTracker_tenantId_assetId_idx" ON "MachineTracker"("tenantId", "assetId");

-- CreateIndex
CREATE INDEX "MachineTracker_tenantId_removedAt_idx" ON "MachineTracker"("tenantId", "removedAt");

-- CreateIndex
CREATE INDEX "MachineTracker_driversInformedByUserId_idx" ON "MachineTracker"("driversInformedByUserId");

-- CreateIndex
CREATE INDEX "MachinePosition_assetId_recordedAt_idx" ON "MachinePosition"("assetId", "recordedAt");

-- CreateIndex
CREATE INDEX "MachinePosition_recordedAt_idx" ON "MachinePosition"("recordedAt");

-- CreateIndex
CREATE INDEX "MachinePosition_tenantId_idx" ON "MachinePosition"("tenantId");

-- CreateIndex
CREATE INDEX "MachinePosition_tenantId_assetId_recordedAt_idx" ON "MachinePosition"("tenantId", "assetId", "recordedAt");

-- CreateIndex
CREATE INDEX "MachinePosition_trackerId_idx" ON "MachinePosition"("trackerId");

-- CreateIndex
CREATE INDEX "WorkedParcel_tenantId_idx" ON "WorkedParcel"("tenantId");

-- CreateIndex
CREATE INDEX "WorkedParcel_tenantId_date_idx" ON "WorkedParcel"("tenantId", "date");

-- CreateIndex
CREATE INDEX "WorkedParcel_tenantId_assetId_date_idx" ON "WorkedParcel"("tenantId", "assetId", "date");

-- CreateIndex
CREATE INDEX "WorkedParcel_parcelId_tenantId_idx" ON "WorkedParcel"("parcelId", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkedParcel_assetId_parcelId_date_key" ON "WorkedParcel"("assetId", "parcelId", "date");

-- CreateIndex
CREATE INDEX "TaskAsset_tenantId_idx" ON "TaskAsset"("tenantId");

-- CreateIndex
CREATE INDEX "TaskAsset_tenantId_assetId_idx" ON "TaskAsset"("tenantId", "assetId");

-- CreateIndex
CREATE INDEX "TaskAsset_assetId_tenantId_idx" ON "TaskAsset"("assetId", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskAsset_taskId_assetId_key" ON "TaskAsset"("taskId", "assetId");

-- CreateIndex
CREATE INDEX "MachineGeofenceState_tenantId_idx" ON "MachineGeofenceState"("tenantId");

-- CreateIndex
CREATE INDEX "MachineGeofenceState_tenantId_outsideSince_idx" ON "MachineGeofenceState"("tenantId", "outsideSince");

-- CreateIndex
CREATE UNIQUE INDEX "MachineGeofenceState_assetId_tenantId_key" ON "MachineGeofenceState"("assetId", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Task_id_tenantId_key" ON "Task"("id", "tenantId");

-- AddForeignKey
ALTER TABLE "MachineTracker" ADD CONSTRAINT "MachineTracker_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineTracker" ADD CONSTRAINT "MachineTracker_assetId_tenantId_fkey" FOREIGN KEY ("assetId", "tenantId") REFERENCES "Asset"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineTracker" ADD CONSTRAINT "MachineTracker_driversInformedByUserId_fkey" FOREIGN KEY ("driversInformedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachinePosition" ADD CONSTRAINT "MachinePosition_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachinePosition" ADD CONSTRAINT "MachinePosition_assetId_tenantId_fkey" FOREIGN KEY ("assetId", "tenantId") REFERENCES "Asset"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachinePosition" ADD CONSTRAINT "MachinePosition_trackerId_fkey" FOREIGN KEY ("trackerId") REFERENCES "MachineTracker"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkedParcel" ADD CONSTRAINT "WorkedParcel_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkedParcel" ADD CONSTRAINT "WorkedParcel_assetId_tenantId_fkey" FOREIGN KEY ("assetId", "tenantId") REFERENCES "Asset"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkedParcel" ADD CONSTRAINT "WorkedParcel_parcelId_tenantId_fkey" FOREIGN KEY ("parcelId", "tenantId") REFERENCES "Parcel"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAsset" ADD CONSTRAINT "TaskAsset_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAsset" ADD CONSTRAINT "TaskAsset_taskId_tenantId_fkey" FOREIGN KEY ("taskId", "tenantId") REFERENCES "Task"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAsset" ADD CONSTRAINT "TaskAsset_assetId_tenantId_fkey" FOREIGN KEY ("assetId", "tenantId") REFERENCES "Asset"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineGeofenceState" ADD CONSTRAINT "MachineGeofenceState_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineGeofenceState" ADD CONSTRAINT "MachineGeofenceState_assetId_tenantId_fkey" FOREIGN KEY ("assetId", "tenantId") REFERENCES "Asset"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════
--  BEYOND PRISMA'S EXPRESSIVENESS — hand-written, deliberate divergence
-- ═══════════════════════════════════════════════════════════════════

-- ONE LIVE TRACKER PER ASSET (#2948 §1).
--
-- A partial unique index, which Prisma's schema language cannot declare, on
-- the precedent of `Asset_tenantId_name_key` ... WHERE "deletedAt" IS NULL.
--
-- A plain UNIQUE on ("assetId") would be wrong: `MachineTracker.removedAt`
-- exists so a position that arrived before a box was pulled still resolves to
-- the machine it came from, so an asset legitimately accumulates a HISTORY of
-- replaced trackers. The constraint is on the live ones.
--
-- Why this is a constraint and not a check in the usecase: the thing it
-- prevents is two live rows for one asset, which would make "the tracker for
-- this machine" ambiguous on the INGEST path — where the resolution is
-- IMEI -> row -> asset -> tenant, and an ambiguous reverse mapping is how a
-- position ends up attributed to the wrong machine with nothing failing.
CREATE UNIQUE INDEX "MachineTracker_one_live_per_asset"
    ON "MachineTracker"("assetId")
    WHERE "removedAt" IS NULL;

-- ═══════════════════════════════════════════════════════════════════
--  ROW-LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════════
--
-- The standard trio, verbatim from 20261030120000_farm_document_library: a
-- USING policy for reads, a SEPARATE insert policy with WITH CHECK, and the
-- superuser bypass. All five tables carry a non-nullable "tenantId", so none
-- of them is the asymmetric `UserSession` case.
--
-- These are NOT optional here. `MachinePosition` holds employee location
-- data, and the application-layer `tenantId` filter is defence in depth
-- rather than the barrier — the DB returning zero rows for an unset context
-- is what makes a cross-tenant read architecturally impossible rather than
-- merely absent from the code today. `tests/guardrails/rls-coverage.test.ts`
-- is DB-backed and fails CI if a tenant table arrives without them.

ALTER TABLE "MachineTracker" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MachineTracker" FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "MachineTracker"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
CREATE POLICY tenant_isolation_insert ON "MachineTracker"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
CREATE POLICY superuser_bypass ON "MachineTracker"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "MachinePosition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MachinePosition" FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "MachinePosition"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
CREATE POLICY tenant_isolation_insert ON "MachinePosition"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
CREATE POLICY superuser_bypass ON "MachinePosition"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "WorkedParcel" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkedParcel" FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "WorkedParcel"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
CREATE POLICY tenant_isolation_insert ON "WorkedParcel"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
CREATE POLICY superuser_bypass ON "WorkedParcel"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "TaskAsset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TaskAsset" FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "TaskAsset"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
CREATE POLICY tenant_isolation_insert ON "TaskAsset"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
CREATE POLICY superuser_bypass ON "TaskAsset"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "MachineGeofenceState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MachineGeofenceState" FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "MachineGeofenceState"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
CREATE POLICY tenant_isolation_insert ON "MachineGeofenceState"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
CREATE POLICY superuser_bypass ON "MachineGeofenceState"
    USING (current_setting('role') != 'app_user');
