-- ═══════════════════════════════════════════════════════════════════
--  GRAIN FULFILMENT — GrainDelivery + the delivery-window sweep index
-- ═══════════════════════════════════════════════════════════════════
--
--  Closes the contract loop. Before this migration a Contract was a flat
--  register: nothing referenced it (`grep contractId` returned nothing),
--  so `status = DELIVERED` meant only that somebody picked it from a
--  dropdown. GrainDelivery is the row that makes delivery a fact —
--  SUM(tonnes) per contract is delivered-to-date, and the difference
--  from Contract.volumeTonnes is what is still owed to that counterparty.
--
--  Every column is plaintext: `tonnes` is a magnitude the rollups SUM
--  in-DB (an encrypted column cannot be SUM()'d), and `reference` is a
--  short external identifier. The commercially-sensitive narrative stays
--  on the parent Contract (terms / pricingNotes, both encrypted), so the
--  Epic-B plaintext-magnitude / encrypted-narrative split holds here by
--  construction.

-- AlterEnum
--  Fired by the daily contract-delivery-window sweep. Added with
--  IF NOT EXISTS (the repo's convention) so a re-run is a no-op; the
--  value is not referenced by any DDL in this migration, so it needs no
--  separate transaction.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CONTRACT_DELIVERY_DUE';

-- CreateTable
CREATE TABLE "GrainDelivery" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3) NOT NULL,
    "tonnes" DECIMAL(14,3) NOT NULL,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" TEXT,
    "retentionUntil" TIMESTAMP(3),

    CONSTRAINT "GrainDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GrainDelivery_id_tenantId_key" ON "GrainDelivery"("id", "tenantId");

-- CreateIndex
CREATE INDEX "GrainDelivery_tenantId_contractId_idx" ON "GrainDelivery"("tenantId", "contractId");

-- CreateIndex
CREATE INDEX "GrainDelivery_tenantId_deliveredAt_idx" ON "GrainDelivery"("tenantId", "deliveredAt");

-- CreateIndex
--  Backs the daily contract-delivery-window sweep: a status-filtered
--  range scan over deliveryEnd. The pre-existing
--  [tenantId, deliveryStart] index backed no query at all.
CREATE INDEX "Contract_tenantId_status_deliveryEnd_idx" ON "Contract"("tenantId", "status", "deliveryEnd");

-- AddForeignKey
ALTER TABLE "GrainDelivery" ADD CONSTRAINT "GrainDelivery_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
--  Composite [contractId, tenantId] → [id, tenantId]: the cross-tenant
--  barrier used throughout grain.prisma. A delivery can never point at a
--  contract in another tenant, even if an id leaks.
ALTER TABLE "GrainDelivery" ADD CONSTRAINT "GrainDelivery_contractId_tenantId_fkey" FOREIGN KEY ("contractId", "tenantId") REFERENCES "Contract"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
--  Row-Level Security — canonical trio. GrainDelivery has a NON-NULL
--  tenantId, so it takes the standard split-policy form (matching
--  Contract / YieldRecord in 20260616071027_add_enterprise_grain).
-- ═══════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['GrainDelivery']
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
END
$$;
