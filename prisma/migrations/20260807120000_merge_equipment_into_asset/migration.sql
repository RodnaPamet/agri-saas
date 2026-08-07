-- Merge `Equipment` into `Asset`.
--
-- `Equipment` backed the journal / farm-task equipment pickers but had
-- ZERO write paths anywhere in the repo (no create/createMany/upsert in
-- src/, prisma/ or scripts/, seeds included), so those pickers were
-- permanently empty and the tractor on /assets could never be the
-- tractor on a field operation. `Asset` is the survivor: it already
-- carries AST-N keys, soft-delete/trash/restore/purge, the audit trail,
-- RLS, assignment notifications, KPI snapshots and a detail page.
--
-- The data migration is empty BY CONSTRUCTION, not by assumption. The
-- guard below proves it at apply time and aborts the whole migration if
-- a single row exists, rather than silently discarding a farm's
-- machine register. Doing the merge now is free; once rows exist on
-- both sides it becomes a reconciliation project.

-- ── 0. Fail loudly rather than discard data ────────────────────────────
DO $$
DECLARE
    equipment_rows bigint;
    link_rows      bigint;
BEGIN
    -- Guard is defensive about its own preconditions: if a previous
    -- partial apply already dropped the table there is nothing to check.
    IF to_regclass('public."Equipment"') IS NOT NULL THEN
        EXECUTE 'SELECT count(*) FROM "Equipment"' INTO equipment_rows;
        IF equipment_rows > 0 THEN
            RAISE EXCEPTION
                'Refusing to drop "Equipment": % row(s) present. This migration assumes the table is empty (it had no write path). Migrate those rows into "Asset" first, then re-run.',
                equipment_rows;
        END IF;
    END IF;

    -- LogEquipment rows can only exist against an Equipment row (FK), so
    -- this should be unreachable — but the column is about to be
    -- repointed at a different table, and a surviving row would silently
    -- change meaning rather than fail.
    IF to_regclass('public."LogEquipment"') IS NOT NULL THEN
        EXECUTE 'SELECT count(*) FROM "LogEquipment"' INTO link_rows;
        IF link_rows > 0 THEN
            RAISE EXCEPTION
                'Refusing to repoint "LogEquipment".equipmentId → assetId: % row(s) present. Those links reference Equipment ids that will not resolve against Asset.',
                link_rows;
        END IF;
    END IF;
END $$;

-- ── 1. Asset gains Equipment's two useful columns ──────────────────────
ALTER TABLE "Asset" ADD COLUMN IF NOT EXISTS "meterValue" DECIMAL(12,1);
ALTER TABLE "Asset" ADD COLUMN IF NOT EXISTS "attributesJson" JSONB;

-- ── 2. Composite-FK barrier + the machine-register query index ─────────
-- `[id, tenantId]` is the target the journal link tables reference, the
-- same barrier Location/Parcel/the retired Equipment carry: a link can
-- never resolve across tenants.
CREATE UNIQUE INDEX IF NOT EXISTS "Asset_id_tenantId_key" ON "Asset"("id", "tenantId");
-- Backs listEquipment: tenant + machine-shaped type, status != RETIRED.
CREATE INDEX IF NOT EXISTS "Asset_tenantId_type_status_idx" ON "Asset"("tenantId", "type", "status");

-- ── 3. Repoint LogEquipment.equipmentId → assetId ──────────────────────
ALTER TABLE "LogEquipment" DROP CONSTRAINT IF EXISTS "LogEquipment_equipmentId_tenantId_fkey";
DROP INDEX IF EXISTS "LogEquipment_tenantId_equipmentId_idx";
ALTER TABLE "LogEquipment" DROP CONSTRAINT IF EXISTS "LogEquipment_logEntryId_equipmentId_key";

ALTER TABLE "LogEquipment" RENAME COLUMN "equipmentId" TO "assetId";

ALTER TABLE "LogEquipment"
    ADD CONSTRAINT "LogEquipment_assetId_tenantId_fkey"
    FOREIGN KEY ("assetId", "tenantId") REFERENCES "Asset"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "LogEquipment_logEntryId_assetId_key" ON "LogEquipment"("logEntryId", "assetId");
CREATE INDEX IF NOT EXISTS "LogEquipment_tenantId_assetId_idx" ON "LogEquipment"("tenantId", "assetId");

-- ── 4. Drop Equipment (its RLS policies go with the table) ─────────────
DROP TABLE IF EXISTS "Equipment";
