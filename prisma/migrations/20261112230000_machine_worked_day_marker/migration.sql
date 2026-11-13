-- #2984 — a run marker for the worked-parcel derivation.
--
-- Without it the `/worked` read cannot say "the derivation ran and this
-- machine worked no parcel": `derivedAt` was read off the `WorkedParcel` rows,
-- and an idle day has none, so it answered null — which the phone renders as
-- «изчисляват се през нощта», for ever, with no error and no metric.
--
-- Additive: a new table, no column changes, so the previous image is
-- unaffected and no down-migration is needed.
--
-- RLS is byte-for-byte the shape its sibling `WorkedParcel` carries, and the
-- separate INSERT policy is deliberate rather than copied: the ALL policy's
-- USING clause does not constrain an INSERT, so without the WITH CHECK a
-- tenant could write a row stamped with another tenant's id.

CREATE TABLE "MachineWorkedDay" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "derivedFrom" TEXT NOT NULL,
    "derivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "positionsConsidered" INTEGER NOT NULL,
    "parcelsMatched" INTEGER NOT NULL,

    CONSTRAINT "MachineWorkedDay_pkey" PRIMARY KEY ("id")
);

-- The idempotence of the nightly job: a re-run UPDATES rather than adding a
-- second claim about the same machine-day.
CREATE UNIQUE INDEX "MachineWorkedDay_assetId_date_key"
    ON "MachineWorkedDay"("assetId", "date");
CREATE INDEX "MachineWorkedDay_tenantId_idx"
    ON "MachineWorkedDay"("tenantId");
CREATE INDEX "MachineWorkedDay_tenantId_assetId_date_idx"
    ON "MachineWorkedDay"("tenantId", "assetId", "date");

ALTER TABLE "MachineWorkedDay"
    ADD CONSTRAINT "MachineWorkedDay_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MachineWorkedDay"
    ADD CONSTRAINT "MachineWorkedDay_assetId_tenantId_fkey"
    FOREIGN KEY ("assetId", "tenantId") REFERENCES "Asset"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MachineWorkedDay" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MachineWorkedDay" FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "MachineWorkedDay"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
CREATE POLICY tenant_isolation_insert ON "MachineWorkedDay"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
CREATE POLICY superuser_bypass ON "MachineWorkedDay"
    USING (current_setting('role') != 'app_user');
