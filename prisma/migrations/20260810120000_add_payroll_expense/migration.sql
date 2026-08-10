-- ═══════════════════════════════════════════════════════════════════
--  PAYROLL EXPENSE — first-class labour cost register (GRAIN module)
-- ═══════════════════════════════════════════════════════════════════
--
--  Labour is frequently a farm's single biggest cost line, and neither
--  the journal event cost (`LogEntry.costAmount`) nor the stock ledger
--  (`StockTransaction.costAmount`) has a slot for "I paid the harvest
--  crew." PayrollExpense is a new PRODUCER of raw cost rows, sitting
--  alongside Contract / YieldRecord in the enterprise-grain domain.
--
--  `plantingId` / `seasonId` are OPTIONAL — plenty of payroll rows (a
--  bookkeeper's salary, a full-time driver's monthly wage) are not
--  attributable to one crop. `amount` stays a PLAINTEXT Decimal(14,2)
--  (matching `ParcelLease.rentAmount`'s precision) so a future cost
--  rollup can SUM it in-DB; `description` is free text that can name an
--  employee or contractor, encrypted at rest via the Epic B manifest
--  (see `src/lib/security/encrypted-fields.ts`) — an encrypted column
--  cannot be SUM()'d, which is exactly why it does not hold the amount.
--
--  Purely additive (new table, no rename/drop of anything read by the
--  previous image) — no deploy/rollback inverse script needed.

-- CreateTable
CREATE TABLE "PayrollExpense" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "incurredOn" TIMESTAMP(3) NOT NULL,
    "description" TEXT,
    "plantingId" TEXT,
    "seasonId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" TEXT,
    "retentionUntil" TIMESTAMP(3),

    CONSTRAINT "PayrollExpense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayrollExpense_id_tenantId_key" ON "PayrollExpense"("id", "tenantId");

-- CreateIndex
--  List filter+sort shape: newest-incurred-first, tenant-scoped
--  (listPayrollExpenses default orderBy: [{ incurredOn: 'desc' }, …]).
CREATE INDEX "PayrollExpense_tenantId_incurredOn_idx" ON "PayrollExpense"("tenantId", "incurredOn");

-- CreateIndex
CREATE INDEX "PayrollExpense_tenantId_plantingId_idx" ON "PayrollExpense"("tenantId", "plantingId");

-- CreateIndex
CREATE INDEX "PayrollExpense_tenantId_seasonId_idx" ON "PayrollExpense"("tenantId", "seasonId");

-- AddForeignKey
ALTER TABLE "PayrollExpense" ADD CONSTRAINT "PayrollExpense_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
--  Composite [plantingId, tenantId] → [id, tenantId]: the cross-tenant
--  barrier used throughout grain.prisma. A payroll row can never point
--  at a planting in another tenant, even if an id leaks.
ALTER TABLE "PayrollExpense" ADD CONSTRAINT "PayrollExpense_plantingId_tenantId_fkey" FOREIGN KEY ("plantingId", "tenantId") REFERENCES "Planting"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollExpense" ADD CONSTRAINT "PayrollExpense_seasonId_tenantId_fkey" FOREIGN KEY ("seasonId", "tenantId") REFERENCES "Season"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
--  Actor FK — SET NULL on user deletion, same shape as Item.createdByUserId
--  (migration 20260613090735_ag_feature1_spray_map).
ALTER TABLE "PayrollExpense" ADD CONSTRAINT "PayrollExpense_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
--  Row-Level Security — canonical trio. PayrollExpense has a NON-NULL
--  tenantId, so it takes the standard split-policy form (matching
--  Contract / YieldRecord / GrainDelivery elsewhere in grain.prisma).
-- ═══════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['PayrollExpense']
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
