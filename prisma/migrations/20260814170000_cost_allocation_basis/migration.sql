-- Selectable cost allocation.
--
-- A cost can now be spread across land other than the single target it
-- links to. The column DEFAULTS to TARGET, so every row written before
-- this migration keeps its exact previous meaning and no existing figure
-- moves — the basis is opt-in, per entry, at entry time.

-- CreateEnum
CREATE TYPE "CostAllocationBasis" AS ENUM ('TARGET', 'HOLDING', 'PARCEL_SUBSET');

-- AlterTable
--  NOT NULL with a default: an in-place backfill of existing rows to the
--  behaviour they already had, rather than a nullable column whose NULL
--  every reader would have to re-interpret as "TARGET" forever.
ALTER TABLE "CostEntry"
    ADD COLUMN "allocationBasis" "CostAllocationBasis" NOT NULL DEFAULT 'TARGET';

-- CreateTable
--  The parcels a PARCEL_SUBSET entry spreads across. This set is the
--  allocation DENOMINATOR, which is why it is a table with real foreign
--  keys rather than an array of ids: a dangling id would be
--  indistinguishable from a smaller subset, so a deleted parcel would
--  silently re-weight a historical cost.
CREATE TABLE "CostEntryAllocationParcel" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "costEntryId" TEXT NOT NULL,
    "parcelId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostEntryAllocationParcel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CostEntryAllocationParcel_id_tenantId_key"
    ON "CostEntryAllocationParcel"("id", "tenantId");

-- CreateIndex
--  A parcel appears at most once per entry. A duplicate would double that
--  parcel's weight in the split, with no visible cause.
CREATE UNIQUE INDEX "CostEntryAllocationParcel_costEntryId_parcelId_key"
    ON "CostEntryAllocationParcel"("costEntryId", "parcelId");

-- CreateIndex
--  One composite per foreign key, per the Layer B rule the CostEntry
--  migration documents: the check reads group[1] only, so a single wide
--  index would leave the second FK uncovered.
CREATE INDEX "CostEntryAllocationParcel_tenantId_costEntryId_idx"
    ON "CostEntryAllocationParcel"("tenantId", "costEntryId");
CREATE INDEX "CostEntryAllocationParcel_tenantId_parcelId_idx"
    ON "CostEntryAllocationParcel"("tenantId", "parcelId");

-- AddForeignKey
ALTER TABLE "CostEntryAllocationParcel" ADD CONSTRAINT "CostEntryAllocationParcel_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
--  Composite [fk, tenantId] → [id, tenantId]: the cross-tenant barrier
--  used throughout grain.prisma. CASCADE on both sides — a subset row is
--  meaningless once either the entry or the parcel is gone, and leaving
--  it would keep a phantom in the denominator.
ALTER TABLE "CostEntryAllocationParcel" ADD CONSTRAINT "CostEntryAllocationParcel_costEntryId_tenantId_fkey"
    FOREIGN KEY ("costEntryId", "tenantId") REFERENCES "CostEntry"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CostEntryAllocationParcel" ADD CONSTRAINT "CostEntryAllocationParcel_parcelId_tenantId_fkey"
    FOREIGN KEY ("parcelId", "tenantId") REFERENCES "Parcel"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS
--  Same canonical shape as every other tenant-scoped table: a USING
--  policy, a matching INSERT WITH CHECK, the superuser bypass, and FORCE
--  so the table owner is not exempt.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['CostEntryAllocationParcel']
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
