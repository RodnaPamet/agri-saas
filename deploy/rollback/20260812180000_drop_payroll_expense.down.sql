-- ═══════════════════════════════════════════════════════════════════
--  INVERSE of 20260812180000_drop_payroll_expense.
--
--  Recreates the table so a PINNED-BACK image — one that predates the
--  payroll retirement and still queries PayrollExpense — can start and
--  serve. Run this BEFORE rolling the image back, not after.
--
--  ── What it can and cannot restore ─────────────────────────────────
--
--  It restores the SHAPE, and it restores the ROWS that were migrated,
--  by reading them back out of CostEntry — the copy in
--  20260812090000 reused the PayrollExpense id verbatim, which is what
--  makes the round trip possible at all.
--
--  It does NOT restore rows that were hard-deleted from CostEntry after
--  the migration, and it does NOT restore the `supplier` / invoice /
--  location / parcel / lease / item data a CostEntry may have gained
--  since — the old table has no columns for those. A rolled-back image
--  sees the payroll it had, not the richer record that replaced it.
--
--  One transaction. Deletes its own _prisma_migrations row last, so a
--  later roll-forward re-applies the drop rather than silently skipping
--  it and leaving the table behind.
-- ═══════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS "PayrollExpense" (
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

CREATE UNIQUE INDEX IF NOT EXISTS "PayrollExpense_id_tenantId_key" ON "PayrollExpense"("id", "tenantId");
CREATE INDEX IF NOT EXISTS "PayrollExpense_tenantId_incurredOn_idx" ON "PayrollExpense"("tenantId", "incurredOn");
CREATE INDEX IF NOT EXISTS "PayrollExpense_tenantId_plantingId_idx" ON "PayrollExpense"("tenantId", "plantingId");
CREATE INDEX IF NOT EXISTS "PayrollExpense_tenantId_seasonId_idx" ON "PayrollExpense"("tenantId", "seasonId");

ALTER TABLE "PayrollExpense" ADD CONSTRAINT "PayrollExpense_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollExpense" ADD CONSTRAINT "PayrollExpense_plantingId_tenantId_fkey" FOREIGN KEY ("plantingId", "tenantId") REFERENCES "Planting"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollExpense" ADD CONSTRAINT "PayrollExpense_seasonId_tenantId_fkey" FOREIGN KEY ("seasonId", "tenantId") REFERENCES "Season"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollExpense" ADD CONSTRAINT "PayrollExpense_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS — the canonical trio, identical to the original migration
-- (20260810120000). Without it the restored table is readable across
-- tenants by `app_user`, which is a worse outcome than the rollback.
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

-- Read the rows back out of CostEntry. The forward migration reused the
-- PayrollExpense id verbatim, so this is an id-for-id restore.
INSERT INTO "PayrollExpense" (
    "id", "tenantId", "amount", "currency", "incurredOn", "description",
    "plantingId", "seasonId", "createdByUserId",
    "createdAt", "updatedAt", "deletedAt", "deletedByUserId", "retentionUntil"
)
SELECT
    c."id", c."tenantId", c."amount", c."currency", c."incurredOn", c."description",
    c."plantingId", c."seasonId", c."createdByUserId",
    c."createdAt", c."updatedAt", c."deletedAt", c."deletedByUserId", c."retentionUntil"
FROM "CostEntry" c
WHERE c."category" = 'PAYROLL'
ON CONFLICT ("id") DO NOTHING;

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260812180000_drop_payroll_expense';

COMMIT;
