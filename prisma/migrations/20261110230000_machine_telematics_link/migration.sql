-- #2948 — the telematics link, the four provider values, and SIMULATED.
-- Owner rulings 2026-11-10: four makes to cover (John Deere, CNH, CLAAS,
-- AGCO), one adapter interface across them plus the Codec 8 listener, and a
-- simulator restricted to a demo farm.
--
-- PURELY ADDITIVE: two enum additions, one table, its indexes and FKs. No
-- DROP, no RENAME, no rewrite of persisted data, so
-- `destructive-migration-has-inverse` needs no `.down.sql`.
--
-- `ALTER TYPE ... ADD VALUE` is safe in one transaction on PG 12+ ONLY because
-- nothing below USES the new value — a Postgres restriction worth knowing
-- before someone adds a backfill to this file. Insert the value in one
-- migration and use it in the next.

-- CreateEnum
CREATE TYPE "TelematicsProvider" AS ENUM ('JOHN_DEERE', 'CNH', 'CLAAS', 'AGCO');

-- AlterEnum
ALTER TYPE "MachinePositionSource" ADD VALUE 'SIMULATED';

-- CreateTable
CREATE TABLE "MachineTelematicsLink" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "provider" "TelematicsProvider" NOT NULL,
    "externalMachineId" TEXT NOT NULL,
    "externalName" TEXT,
    "connectionId" TEXT NOT NULL,
    "syncCursor" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "driversInformedAt" TIMESTAMP(3) NOT NULL,
    "driversInformedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MachineTelematicsLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MachineTelematicsLink_tenantId_idx" ON "MachineTelematicsLink"("tenantId");

-- CreateIndex
CREATE INDEX "MachineTelematicsLink_tenantId_assetId_idx" ON "MachineTelematicsLink"("tenantId", "assetId");

-- CreateIndex
CREATE INDEX "MachineTelematicsLink_tenantId_provider_idx" ON "MachineTelematicsLink"("tenantId", "provider");

-- CreateIndex
CREATE INDEX "MachineTelematicsLink_tenantId_removedAt_idx" ON "MachineTelematicsLink"("tenantId", "removedAt");

-- CreateIndex
CREATE INDEX "MachineTelematicsLink_connectionId_idx" ON "MachineTelematicsLink"("connectionId");

-- CreateIndex
CREATE INDEX "MachineTelematicsLink_driversInformedByUserId_idx" ON "MachineTelematicsLink"("driversInformedByUserId");

-- AddForeignKey
ALTER TABLE "MachineTelematicsLink" ADD CONSTRAINT "MachineTelematicsLink_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineTelematicsLink" ADD CONSTRAINT "MachineTelematicsLink_assetId_tenantId_fkey" FOREIGN KEY ("assetId", "tenantId") REFERENCES "Asset"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineTelematicsLink" ADD CONSTRAINT "MachineTelematicsLink_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineTelematicsLink" ADD CONSTRAINT "MachineTelematicsLink_driversInformedByUserId_fkey" FOREIGN KEY ("driversInformedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════
--  BEYOND PRISMA'S EXPRESSIVENESS — hand-written, deliberate
-- ═══════════════════════════════════════════════════════════════════

-- ONE LIVE LINK PER ASSET, on `MachineTracker_one_live_per_asset`'s precedent
-- and for the same reason: `removedAt` exists so a position that arrived
-- before a machine was sold still resolves to the link it came through, so an
-- asset legitimately accumulates a HISTORY of links. The constraint is on the
-- live ones.
CREATE UNIQUE INDEX "MachineTelematicsLink_one_live_per_asset"
    ON "MachineTelematicsLink"("assetId")
    WHERE "removedAt" IS NULL;

-- ONE LIVE CLAIM ON A VENDOR MACHINE, across the whole deployment.
--
-- The integrity equivalent of `MachineTracker.imei` being globally unique. A
-- vendor's machine id is unique within that vendor, and one physical tractor
-- belongs to one farm at a time — so without this, two farms could both claim
-- the same machine and whose tenant its positions land in would depend on
-- insertion order. Partial, so a SALE is expressible: the old link is marked
-- removed and the new farm may claim it.
CREATE UNIQUE INDEX "MachineTelematicsLink_one_live_claim_per_machine"
    ON "MachineTelematicsLink"("provider", "externalMachineId")
    WHERE "removedAt" IS NULL;

-- ═══════════════════════════════════════════════════════════════════
--  ROW-LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════════
--
-- The standard trio. `ALTER DEFAULT PRIVILEGES` (20260323180000) already
-- grants `app_user` full DML on every new table in `public`, so this table is
-- reachable by a tenant session the moment it exists — and it names which of
-- a farm's machines are tracked and who confirmed the drivers were told.

ALTER TABLE "MachineTelematicsLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MachineTelematicsLink" FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "MachineTelematicsLink"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
CREATE POLICY tenant_isolation_insert ON "MachineTelematicsLink"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
CREATE POLICY superuser_bypass ON "MachineTelematicsLink"
    USING (current_setting('role') != 'app_user');
