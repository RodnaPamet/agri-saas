-- #2948 stage 5 — where a machine was last seen relative to its farm's area.
--
-- "One push per EVENT" (owner ruling) means one alert per departure rather
-- than one per interval while a machine is away. A departure is a BOUNDARY
-- CROSSING, so the job needs the verdict it reached last time, and nothing
-- else records it.
--
-- RLS is the party-scoped shape its siblings carry. There is no `app_user`
-- write arm: the verdict is the JOB's, written through the privileged client,
-- and a caller able to write it could suppress their own departure alert by
-- claiming to be inside. The read arm exists so a future screen can show
-- "last seen outside the farm" without a second privileged path.

CREATE TABLE "MachineAreaState" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "outside" BOOLEAN NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL,
    "alertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MachineAreaState_pkey" PRIMARY KEY ("id")
);

-- One row per machine: the job upserts rather than appending a crossing
-- history, which would be a second surveillance trace of the same driver.
CREATE UNIQUE INDEX "MachineAreaState_assetId_key" ON "MachineAreaState"("assetId");
CREATE INDEX "MachineAreaState_tenantId_idx" ON "MachineAreaState"("tenantId");
CREATE INDEX "MachineAreaState_tenantId_outside_idx"
    ON "MachineAreaState"("tenantId", "outside");

ALTER TABLE "MachineAreaState"
    ADD CONSTRAINT "MachineAreaState_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MachineAreaState"
    ADD CONSTRAINT "MachineAreaState_assetId_tenantId_fkey"
    FOREIGN KEY ("assetId", "tenantId") REFERENCES "Asset"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MachineAreaState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MachineAreaState" FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "MachineAreaState"
    FOR SELECT USING ("tenantId" = current_setting('app.tenant_id', true)::text);
CREATE POLICY superuser_bypass ON "MachineAreaState"
    USING (current_setting('role') != 'app_user');
