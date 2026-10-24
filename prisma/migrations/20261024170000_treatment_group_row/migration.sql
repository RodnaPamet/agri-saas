-- The treatment becomes a ROW, so a correction has something to commit in.
--
-- #2172, owner ruling 2026-10-24. A treatment has always been a shared HANDLE
-- carried on N Task rows and N LogEntry rows with no row of its own. That is
-- enough to fold the ДНЕВНИК list and to withdraw a treatment; it is not enough
-- to correct one, because there is nothing to lock and nowhere to put a version
-- that survives a correction ADDING or DROPPING a parcel.
--
-- This migration is additive: two new tables and a backfill. No existing column
-- changes, nothing is dropped, and no existing write path is altered — the
-- version is wired up in the follow-up that adds the correction route.

-- ── TreatmentGroup ───────────────────────────────────────────────────
--
-- The primary key is (tenantId, id), NOT id alone, and that is load-bearing for
-- the backfill below. `Task.treatmentGroupId` can be the request's
-- Idempotency-Key, which is scoped per tenant (`Task_tenantId_clientMutationId_key`),
-- so two farms can legitimately carry the same handle. A global primary key
-- would make the backfill fail on exactly that data, and it would fail as a
-- constraint violation during deploy rather than as anything a reader could
-- diagnose.
CREATE TABLE IF NOT EXISTS "TreatmentGroup" (
    "id"        TEXT NOT NULL,
    "tenantId"  TEXT NOT NULL,
    "version"   INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TreatmentGroup_pkey" PRIMARY KEY ("tenantId", "id")
);

CREATE INDEX IF NOT EXISTS "TreatmentGroup_tenantId_updatedAt_idx"
    ON "TreatmentGroup" ("tenantId", "updatedAt");

ALTER TABLE "TreatmentGroup"
    ADD CONSTRAINT "TreatmentGroup_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── TreatmentCorrection ──────────────────────────────────────────────
--
-- Append-only. `previous` is the WHOLE prior definition rather than a diff, so
-- reading the trail never means reconstructing a regulated record.
-- `changedFields` names what moved without storing a CLASSIFICATION of it: a
-- reader labels an observation (phenophase, quarantinePeriodDays,
-- treatedAreaHa) against a fact (product, dose) from the names, and which
-- fields count as which can change later without a migration and without
-- re-labelling history that cannot be re-derived.
CREATE TABLE IF NOT EXISTS "TreatmentCorrection" (
    "id"                TEXT NOT NULL,
    "tenantId"          TEXT NOT NULL,
    "groupId"           TEXT NOT NULL,
    "previous"          JSONB NOT NULL,
    "changedFields"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "correctedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correctedByUserId" TEXT,

    CONSTRAINT "TreatmentCorrection_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TreatmentCorrection_tenantId_groupId_idx"
    ON "TreatmentCorrection" ("tenantId", "groupId");
CREATE INDEX IF NOT EXISTS "TreatmentCorrection_tenantId_correctedAt_idx"
    ON "TreatmentCorrection" ("tenantId", "correctedAt");

ALTER TABLE "TreatmentCorrection"
    ADD CONSTRAINT "TreatmentCorrection_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Composite, so a correction cannot point at another tenant's treatment: the FK
-- itself carries the tenant rather than leaving that to the RLS policy alone.
ALTER TABLE "TreatmentCorrection"
    ADD CONSTRAINT "TreatmentCorrection_tenantId_groupId_fkey"
    FOREIGN KEY ("tenantId", "groupId") REFERENCES "TreatmentGroup"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Backfill ─────────────────────────────────────────────────────────
--
-- From `Task`, NOT from `LogEntry`, and that is the whole correctness of this
-- statement.
--
-- `LogEntry.treatmentGroupId` is NOT NULL and an entry belonging to no
-- treatment gets its OWN unique value, so it folds to itself and the Дневник
-- needs no second code path. (A nullable key would be worse than untidy:
-- `DISTINCT ON` treats all NULLs as ONE value, measured collapsing 4 manual
-- entries into 1 ghost row.) So most LogEntry handles name no treatment, and
-- backfilling from there would create one TreatmentGroup per manual journal
-- entry a farm has ever written.
--
-- `Task.treatmentGroupId` is the real discriminator: only `recordDiaryTreatment`
-- writes it, and it is NULL for every task that is not part of a diary
-- treatment.
--
-- DISTINCT over the PAIR, matching the primary key, so a handle shared across
-- two tenants yields two rows rather than a violation. `version` starts at 0 —
-- its default — because nothing has corrected these yet, and a backfilled row
-- claiming a version it never served would be a lie a client could act on.
INSERT INTO "TreatmentGroup" ("id", "tenantId", "createdAt", "updatedAt")
SELECT DISTINCT t."treatmentGroupId", t."tenantId", MIN(t."createdAt"), MAX(t."updatedAt")
  FROM "Task" t
 WHERE t."treatmentGroupId" IS NOT NULL
 GROUP BY t."treatmentGroupId", t."tenantId"
ON CONFLICT ("tenantId", "id") DO NOTHING;

-- ── RLS trio ─────────────────────────────────────────────────────────
--
-- `tenant_isolation` + `superuser_bypass` + FORCE, which is what
-- `tests/guardrails/rls-coverage.test.ts` asserts for every tenant-scoped
-- model. Its population comes from the live DMMF, so both tables entered that
-- inventory the moment they gained a `tenantId` and the guard fails by name
-- without this block.

ALTER TABLE "TreatmentGroup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TreatmentGroup" FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "TreatmentGroup";
CREATE POLICY tenant_isolation ON "TreatmentGroup"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "TreatmentGroup";
CREATE POLICY tenant_isolation_insert ON "TreatmentGroup"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "TreatmentGroup";
CREATE POLICY superuser_bypass ON "TreatmentGroup"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "TreatmentCorrection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TreatmentCorrection" FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "TreatmentCorrection";
CREATE POLICY tenant_isolation ON "TreatmentCorrection"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "TreatmentCorrection";
CREATE POLICY tenant_isolation_insert ON "TreatmentCorrection"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "TreatmentCorrection";
CREATE POLICY superuser_bypass ON "TreatmentCorrection"
    USING (current_setting('role') != 'app_user');
