-- CreateEnum
CREATE TYPE "CostCategory" AS ENUM ('PAYROLL', 'RENT', 'FERTILIZER', 'FUEL', 'SEED', 'PESTICIDE', 'SERVICE', 'OTHER');

-- CreateTable
CREATE TABLE "CostEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "category" "CostCategory" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "incurredOn" TIMESTAMP(3) NOT NULL,
    "supplier" TEXT,
    "description" TEXT,
    "invoiceFileId" TEXT,
    "plantingId" TEXT,
    "seasonId" TEXT,
    "locationId" TEXT,
    "parcelId" TEXT,
    "leaseId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" TEXT,
    "retentionUntil" TIMESTAMP(3),

    CONSTRAINT "CostEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CostEntry_id_tenantId_key" ON "CostEntry"("id", "tenantId");

-- CreateIndex
--  List filter+sort shape: newest-incurred-first, tenant-scoped.
CREATE INDEX "CostEntry_tenantId_incurredOn_idx" ON "CostEntry"("tenantId", "incurredOn");

-- CreateIndex
--  The category facet applied to that same sort.
CREATE INDEX "CostEntry_tenantId_category_incurredOn_idx" ON "CostEntry"("tenantId", "category", "incurredOn");

-- CreateIndex
--  One composite PER foreign key, deliberately not one wide index: the
--  Layer B check tests group[1] === fk and never reads group[2], so a
--  combined [tenantId, plantingId, seasonId] would leave seasonId
--  unindexed as far as the guardrail — and as far as Postgres, for any
--  query that filters on seasonId alone.
CREATE INDEX "CostEntry_tenantId_plantingId_idx" ON "CostEntry"("tenantId", "plantingId");
CREATE INDEX "CostEntry_tenantId_seasonId_idx" ON "CostEntry"("tenantId", "seasonId");
CREATE INDEX "CostEntry_tenantId_locationId_idx" ON "CostEntry"("tenantId", "locationId");
CREATE INDEX "CostEntry_tenantId_parcelId_idx" ON "CostEntry"("tenantId", "parcelId");
CREATE INDEX "CostEntry_tenantId_leaseId_idx" ON "CostEntry"("tenantId", "leaseId");
CREATE INDEX "CostEntry_tenantId_invoiceFileId_idx" ON "CostEntry"("tenantId", "invoiceFileId");

-- AddForeignKey
ALTER TABLE "CostEntry" ADD CONSTRAINT "CostEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
--  Composite [fk, tenantId] → [id, tenantId]: the cross-tenant barrier used
--  throughout grain.prisma. A cost row can never point at a planting, a
--  parcel or a lease in another tenant, even if an id leaks.
ALTER TABLE "CostEntry" ADD CONSTRAINT "CostEntry_plantingId_tenantId_fkey" FOREIGN KEY ("plantingId", "tenantId") REFERENCES "Planting"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostEntry" ADD CONSTRAINT "CostEntry_seasonId_tenantId_fkey" FOREIGN KEY ("seasonId", "tenantId") REFERENCES "Season"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostEntry" ADD CONSTRAINT "CostEntry_locationId_tenantId_fkey" FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostEntry" ADD CONSTRAINT "CostEntry_parcelId_tenantId_fkey" FOREIGN KEY ("parcelId", "tenantId") REFERENCES "Parcel"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostEntry" ADD CONSTRAINT "CostEntry_leaseId_tenantId_fkey" FOREIGN KEY ("leaseId", "tenantId") REFERENCES "ParcelLease"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
--  FileRecord carries no [id, tenantId] unique, so this is a plain id FK —
--  same as LogEntry.fileRecordId. Same-tenant ownership of an invoice is a
--  USECASE obligation (assertUsableInvoice), which also enforces STORED and
--  not-soft-deleted.
ALTER TABLE "CostEntry" ADD CONSTRAINT "CostEntry_invoiceFileId_fkey" FOREIGN KEY ("invoiceFileId") REFERENCES "FileRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
--  Actor FK — SET NULL on user deletion, same shape as
--  PayrollExpense.createdByUserId.
ALTER TABLE "CostEntry" ADD CONSTRAINT "CostEntry_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
--  Row-Level Security — canonical trio. CostEntry has a NON-NULL
--  tenantId, so it takes the standard split-policy form (matching
--  PayrollExpense / Contract / YieldRecord elsewhere in grain.prisma).
--  Every foreign key is nullable, which is irrelevant here: the split
--  form keys on tenantId alone, and no guardrail reads FK nullability.
-- ═══════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['CostEntry']
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
