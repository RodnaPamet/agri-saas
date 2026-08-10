-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK — undo `20260809120000_rename_control_to_practice`
-- ═══════════════════════════════════════════════════════════════════════
--
-- WHY THIS FILE EXISTS
--
-- The two halves of a deploy roll back at different speeds. Pinning
-- Watchtower to the previous image does NOT undo a migration, so after
-- the rename shipped, the old image queries `Control`, `controlId` and
-- `ControlStatus` — none of which exist any more. An image-only rollback
-- does not degrade, it fails outright.
--
-- Without this file the only remaining option is a snapshot restore:
-- daily at 02:00 UTC, so up to 24 hours of farm data thrown away to undo
-- a UI-level regression (see docs/backup-restore.md). This script makes
-- rollback a rename instead — no rows move, nothing is lost.
--
-- Prisma has no down-migrations, so this is deliberately NOT a migration
-- directory. It is a psql script an operator runs by hand.
--
-- ── HOW TO RUN ────────────────────────────────────────────────────────
--
--   1. Stop the app + worker first. Running this under a live app means
--      in-flight queries hit tables mid-rename.
--        gcloud compute ssh agrent --zone europe-west1-b \
--          --command "cd /opt/agrent && sudo docker compose \
--            -f docker-compose.vm.yml stop app worker"
--
--   2. Apply, against the DIRECT database URL (not PgBouncer — this is
--      DDL in one transaction):
--        psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 \
--          -f deploy/rollback/20260809120000_rename_control_to_practice.down.sql
--
--   3. Start the PREVIOUS image (the one from before 1.114.3). If you
--      start the new one, its entrypoint re-applies the forward
--      migration and you are back where you started.
--
-- The whole script is one transaction: Postgres DDL is transactional, so
-- a failure anywhere leaves the database exactly as it was. That is a
-- deliberate improvement on the forward migration, which is not wrapped —
-- a rollback runs under time pressure and must not half-apply.
--
-- ── THE `_prisma_migrations` ROW ──────────────────────────────────────
--
-- The last statement deletes the migration's bookkeeping row, and it is
-- load-bearing rather than tidy-up. `prisma migrate deploy` decides what
-- to run by consulting that table. Leave the row in place and a later
-- roll-forward SKIPS the rename as already-applied — new code, old
-- schema, the same outage in the opposite direction. Deleting it means
-- redeploying the new image simply re-applies the rename and recovers.
--
-- So this script is reversible: down → up → down all work.
--
-- ── VERIFIED ─────────────────────────────────────────────────────────
--
-- Executed against a real Postgres 16 carrying seeded rows, not just
-- read: full migration history applied, this script run, then the
-- forward migration re-applied. Checks in
-- `tests/integration/rename-rollback.test.ts`.

BEGIN;

-- ── Enum VALUES ──────────────────────────────────────────────────────
-- Metadata-only, like the forward direction: existing rows follow the
-- value implicitly, with no rewrite and no cast.
ALTER TYPE "TaskLinkEntityType"      RENAME VALUE 'PRACTICE' TO 'CONTROL';
ALTER TYPE "VendorLinkEntityType"    RENAME VALUE 'PRACTICE' TO 'CONTROL';
ALTER TYPE "AuditPackItemEntityType" RENAME VALUE 'PRACTICE' TO 'CONTROL';
ALTER TYPE "WorkItemType"            RENAME VALUE 'PRACTICE_GAP' TO 'CONTROL_GAP';
ALTER TYPE "NotificationType"        RENAME VALUE 'PRACTICE_ASSIGNED' TO 'CONTROL_ASSIGNED';

-- ── Data: the persisted permission domain ────────────────────────────
-- The mirror of the forward rekey, and just as load-bearing. Leave the
-- stored blob saying `practices` while the old code reads `controls` and
-- `parsePermissionsJson` silently falls back to base-role defaults — no
-- error, no log, just different answers to "may this user do that".
-- Guarded on `jsonb_typeof` so a malformed row is skipped, and
-- idempotent: the `?` predicate makes a re-run update 0 rows.
UPDATE "TenantCustomRole"
   SET "permissionsJson" =
         ("permissionsJson" - 'practices')
         || jsonb_build_object('controls', "permissionsJson" -> 'practices')
 WHERE jsonb_typeof("permissionsJson") = 'object'
   AND "permissionsJson" ? 'practices';

-- ── Constraint names ─────────────────────────────────────────────────
-- These run BEFORE the table renames because `ALTER TABLE … RENAME
-- CONSTRAINT` addresses the table by its CURRENT name, which is still
-- `Practice*` at this point.
ALTER TABLE "Evidence" RENAME CONSTRAINT "Evidence_practiceId_fkey" TO "Evidence_controlId_fkey";
ALTER TABLE "Finding" RENAME CONSTRAINT "Finding_compensatingPracticeId_fkey" TO "Finding_compensatingControlId_fkey";
ALTER TABLE "Finding" RENAME CONSTRAINT "Finding_practiceId_fkey" TO "Finding_controlId_fkey";
ALTER TABLE "FrameworkMapping" RENAME CONSTRAINT "FrameworkMapping_toPracticeId_fkey" TO "FrameworkMapping_toControlId_fkey";
ALTER TABLE "IntegrationExecution" RENAME CONSTRAINT "IntegrationExecution_practiceId_fkey" TO "IntegrationExecution_controlId_fkey";
ALTER TABLE "PolicyPracticeLink" RENAME CONSTRAINT "PolicyPracticeLink_practiceId_fkey" TO "PolicyControlLink_controlId_fkey";
ALTER TABLE "PolicyPracticeLink" RENAME CONSTRAINT "PolicyPracticeLink_policyId_tenantId_fkey" TO "PolicyControlLink_policyId_tenantId_fkey";
ALTER TABLE "PolicyPracticeLink" RENAME CONSTRAINT "PolicyPracticeLink_tenantId_fkey" TO "PolicyControlLink_tenantId_fkey";
ALTER TABLE "Practice" RENAME CONSTRAINT "Practice_applicabilityDecidedByUserId_fkey" TO "Control_applicabilityDecidedByUserId_fkey";
ALTER TABLE "Practice" RENAME CONSTRAINT "Practice_createdByUserId_fkey" TO "Control_createdByUserId_fkey";
ALTER TABLE "Practice" RENAME CONSTRAINT "Practice_ownerUserId_fkey" TO "Control_ownerUserId_fkey";
ALTER TABLE "Practice" RENAME CONSTRAINT "Practice_tenantId_fkey" TO "Control_tenantId_fkey";
ALTER TABLE "PracticeAsset" RENAME CONSTRAINT "PracticeAsset_assetId_fkey" TO "ControlAsset_assetId_fkey";
ALTER TABLE "PracticeAsset" RENAME CONSTRAINT "PracticeAsset_practiceId_fkey" TO "ControlAsset_controlId_fkey";
ALTER TABLE "PracticeAsset" RENAME CONSTRAINT "PracticeAsset_createdByUserId_fkey" TO "ControlAsset_createdByUserId_fkey";
ALTER TABLE "PracticeAsset" RENAME CONSTRAINT "PracticeAsset_tenantId_fkey" TO "ControlAsset_tenantId_fkey";
ALTER TABLE "PracticeEvidenceLink" RENAME CONSTRAINT "PracticeEvidenceLink_practiceId_fkey" TO "ControlEvidenceLink_controlId_fkey";
ALTER TABLE "PracticeEvidenceLink" RENAME CONSTRAINT "PracticeEvidenceLink_createdByUserId_fkey" TO "ControlEvidenceLink_createdByUserId_fkey";
ALTER TABLE "PracticeEvidenceLink" RENAME CONSTRAINT "PracticeEvidenceLink_tenantId_fkey" TO "ControlEvidenceLink_tenantId_fkey";
ALTER TABLE "PracticeRequirementLink" RENAME CONSTRAINT "PracticeRequirementLink_practiceId_fkey" TO "ControlRequirementLink_controlId_fkey";
ALTER TABLE "PracticeRequirementLink" RENAME CONSTRAINT "PracticeRequirementLink_requirementId_fkey" TO "ControlRequirementLink_requirementId_fkey";
ALTER TABLE "PracticeRequirementLink" RENAME CONSTRAINT "PracticeRequirementLink_tenantId_fkey" TO "ControlRequirementLink_tenantId_fkey";
ALTER TABLE "PracticeTask" RENAME CONSTRAINT "PracticeTask_assigneeUserId_fkey" TO "ControlTask_assigneeUserId_fkey";
ALTER TABLE "PracticeTask" RENAME CONSTRAINT "PracticeTask_practiceId_fkey" TO "ControlTask_controlId_fkey";
ALTER TABLE "PracticeTask" RENAME CONSTRAINT "PracticeTask_tenantId_fkey" TO "ControlTask_tenantId_fkey";
ALTER TABLE "ProcessEdgePractice" RENAME CONSTRAINT "ProcessEdgePractice_edgeId_tenantId_fkey" TO "ProcessEdgeControl_edgeId_tenantId_fkey";
ALTER TABLE "ProcessEdgePractice" RENAME CONSTRAINT "ProcessEdgePractice_tenantId_fkey" TO "ProcessEdgeControl_tenantId_fkey";
ALTER TABLE "Task" RENAME CONSTRAINT "Task_practiceId_fkey" TO "Task_controlId_fkey";

-- Primary-key constraint names.
ALTER TABLE "PolicyPracticeLink" RENAME CONSTRAINT "PolicyPracticeLink_pkey" TO "PolicyControlLink_pkey";
ALTER TABLE "Practice" RENAME CONSTRAINT "Practice_pkey" TO "Control_pkey";
ALTER TABLE "PracticeAsset" RENAME CONSTRAINT "PracticeAsset_pkey" TO "ControlAsset_pkey";
ALTER TABLE "PracticeEvidenceLink" RENAME CONSTRAINT "PracticeEvidenceLink_pkey" TO "ControlEvidenceLink_pkey";
ALTER TABLE "PracticeKeySequence" RENAME CONSTRAINT "PracticeKeySequence_pkey" TO "ControlKeySequence_pkey";
ALTER TABLE "PracticeRequirementLink" RENAME CONSTRAINT "PracticeRequirementLink_pkey" TO "ControlRequirementLink_pkey";
ALTER TABLE "PracticeTask" RENAME CONSTRAINT "PracticeTask_pkey" TO "ControlTask_pkey";
ALTER TABLE "ProcessEdgePractice" RENAME CONSTRAINT "ProcessEdgePractice_pkey" TO "ProcessEdgeControl_pkey";

-- ── Index names ──────────────────────────────────────────────────────
-- `ALTER INDEX` names the index directly, so these are order-independent.
ALTER INDEX "Evidence_tenantId_practiceId_idx" RENAME TO "Evidence_tenantId_controlId_idx";
ALTER INDEX "Evidence_tenantId_sourceLogEntryId_practiceId_key" RENAME TO "Evidence_tenantId_sourceLogEntryId_controlId_key";
ALTER INDEX "Finding_tenantId_compensatingPracticeId_idx" RENAME TO "Finding_tenantId_compensatingControlId_idx";
ALTER INDEX "Finding_tenantId_practiceId_idx" RENAME TO "Finding_tenantId_controlId_idx";
ALTER INDEX "FrameworkMapping_fromRequirementId_toPracticeId_key" RENAME TO "FrameworkMapping_fromRequirementId_toControlId_key";
ALTER INDEX "IntegrationExecution_tenantId_practiceId_idx" RENAME TO "IntegrationExecution_tenantId_controlId_idx";
ALTER INDEX "PolicyPracticeLink_policyId_practiceId_key" RENAME TO "PolicyControlLink_policyId_controlId_key";
ALTER INDEX "PolicyPracticeLink_tenantId_practiceId_idx" RENAME TO "PolicyControlLink_tenantId_controlId_idx";
ALTER INDEX "PolicyPracticeLink_tenantId_idx" RENAME TO "PolicyControlLink_tenantId_idx";
ALTER INDEX "PolicyPracticeLink_tenantId_policyId_idx" RENAME TO "PolicyControlLink_tenantId_policyId_idx";
ALTER INDEX "Practice_id_tenantId_key" RENAME TO "Control_id_tenantId_key";
ALTER INDEX "Practice_nextDueAt_idx" RENAME TO "Control_nextDueAt_idx";
ALTER INDEX "Practice_ownerUserId_idx" RENAME TO "Control_ownerUserId_idx";
ALTER INDEX "Practice_tenantId_applicability_idx" RENAME TO "Control_tenantId_applicability_idx";
ALTER INDEX "Practice_tenantId_category_idx" RENAME TO "Control_tenantId_category_idx";
ALTER INDEX "Practice_tenantId_code_idx" RENAME TO "Control_tenantId_code_idx";
ALTER INDEX "Practice_tenantId_createdAt_idx" RENAME TO "Control_tenantId_createdAt_idx";
ALTER INDEX "Practice_tenantId_deletedAt_idx" RENAME TO "Control_tenantId_deletedAt_idx";
ALTER INDEX "Practice_tenantId_idx" RENAME TO "Control_tenantId_idx";
ALTER INDEX "Practice_tenantId_ownerUserId_idx" RENAME TO "Control_tenantId_ownerUserId_idx";
ALTER INDEX "Practice_tenantId_status_idx" RENAME TO "Control_tenantId_status_idx";
ALTER INDEX "PracticeAsset_tenantId_assetId_idx" RENAME TO "ControlAsset_tenantId_assetId_idx";
ALTER INDEX "PracticeAsset_tenantId_practiceId_assetId_key" RENAME TO "ControlAsset_tenantId_controlId_assetId_key";
ALTER INDEX "PracticeAsset_tenantId_idx" RENAME TO "ControlAsset_tenantId_idx";
ALTER INDEX "PracticeEvidenceLink_practiceId_idx" RENAME TO "ControlEvidenceLink_controlId_idx";
ALTER INDEX "PracticeEvidenceLink_practiceId_kind_fileId_key" RENAME TO "ControlEvidenceLink_controlId_kind_fileId_key";
ALTER INDEX "PracticeEvidenceLink_practiceId_kind_url_key" RENAME TO "ControlEvidenceLink_controlId_kind_url_key";
ALTER INDEX "PracticeEvidenceLink_tenantId_idx" RENAME TO "ControlEvidenceLink_tenantId_idx";
ALTER INDEX "PracticeRequirementLink_practiceId_requirementId_key" RENAME TO "ControlRequirementLink_controlId_requirementId_key";
ALTER INDEX "PracticeRequirementLink_tenantId_requirementId_idx" RENAME TO "ControlRequirementLink_tenantId_requirementId_idx";
ALTER INDEX "PracticeTask_practiceId_idx" RENAME TO "ControlTask_controlId_idx";
ALTER INDEX "PracticeTask_dueAt_idx" RENAME TO "ControlTask_dueAt_idx";
ALTER INDEX "PracticeTask_status_idx" RENAME TO "ControlTask_status_idx";
ALTER INDEX "PracticeTask_tenantId_idx" RENAME TO "ControlTask_tenantId_idx";
ALTER INDEX "PracticeTask_tenantId_status_dueAt_idx" RENAME TO "ControlTask_tenantId_status_dueAt_idx";
ALTER INDEX "ProcessEdgePractice_edgeId_practiceKey_key" RENAME TO "ProcessEdgeControl_edgeId_controlKey_key";
ALTER INDEX "ProcessEdgePractice_tenantId_practiceId_idx" RENAME TO "ProcessEdgeControl_tenantId_controlId_idx";
ALTER INDEX "ProcessEdgePractice_tenantId_processMapId_idx" RENAME TO "ProcessEdgeControl_tenantId_processMapId_idx";
ALTER INDEX "Task_tenantId_practiceId_idx" RENAME TO "Task_tenantId_controlId_idx";
ALTER INDEX "Task_tenantId_practiceId_status_idx" RENAME TO "Task_tenantId_controlId_status_idx";

-- Not part of the rename. The forward migration folded in one unrelated
-- pre-existing drift fix, and it has to be undone here too — otherwise a
-- later roll-forward aborts on `ALTER INDEX … RENAME` against an index
-- that no longer carries the old name.
ALTER INDEX "MarketPriceSeries_source_commodity_region_stage_currency_un_key" RENAME TO "MarketPriceSeries_source_commodity_region_stage_currency_unit_k";

-- ── Columns ──────────────────────────────────────────────────────────
-- Still addressed by the CURRENT (`Practice*`) table names.
ALTER TABLE "ComplianceSnapshot" RENAME COLUMN "practicesTotal"       TO "controlsTotal";
ALTER TABLE "ComplianceSnapshot" RENAME COLUMN "practicesImplemented" TO "controlsImplemented";
ALTER TABLE "ComplianceSnapshot" RENAME COLUMN "practicesInProgress"  TO "controlsInProgress";
ALTER TABLE "ComplianceSnapshot" RENAME COLUMN "practicesNotStarted"  TO "controlsNotStarted";
ALTER TABLE "ComplianceSnapshot" RENAME COLUMN "practicesApplicable"  TO "controlsApplicable";
ALTER TABLE "ComplianceSnapshot" RENAME COLUMN "practiceCoverageBps"  TO "controlCoverageBps";

ALTER TABLE "Finding"                 RENAME COLUMN "compensatingPracticeId" TO "compensatingControlId";
ALTER TABLE "Finding"                 RENAME COLUMN "practiceId" TO "controlId";
ALTER TABLE "FrameworkMapping"        RENAME COLUMN "toPracticeId" TO "toControlId";
ALTER TABLE "IntegrationExecution"    RENAME COLUMN "practiceId" TO "controlId";
ALTER TABLE "Task"                    RENAME COLUMN "practiceId" TO "controlId";
ALTER TABLE "Evidence"                RENAME COLUMN "practiceId" TO "controlId";
ALTER TABLE "ProcessEdgePractice"     RENAME COLUMN "practiceKey" TO "controlKey";
ALTER TABLE "ProcessEdgePractice"     RENAME COLUMN "practiceId" TO "controlId";
ALTER TABLE "PolicyPracticeLink"      RENAME COLUMN "practiceId" TO "controlId";
ALTER TABLE "PracticeRequirementLink" RENAME COLUMN "practiceId" TO "controlId";
ALTER TABLE "PracticeEvidenceLink"    RENAME COLUMN "practiceId" TO "controlId";
ALTER TABLE "PracticeTask"            RENAME COLUMN "practiceId" TO "controlId";
ALTER TABLE "PracticeAsset"           RENAME COLUMN "practiceId" TO "controlId";

-- ── Tables ────────────────────────────────────────────────────────────
ALTER TABLE "ProcessEdgePractice"     RENAME TO "ProcessEdgeControl";
ALTER TABLE "PolicyPracticeLink"      RENAME TO "PolicyControlLink";
ALTER TABLE "PracticeKeySequence"     RENAME TO "ControlKeySequence";
ALTER TABLE "PracticeRequirementLink" RENAME TO "ControlRequirementLink";
ALTER TABLE "PracticeEvidenceLink"    RENAME TO "ControlEvidenceLink";
ALTER TABLE "PracticeTask"            RENAME TO "ControlTask";
ALTER TABLE "PracticeAsset"           RENAME TO "ControlAsset";
ALTER TABLE "Practice"                RENAME TO "Control";

-- ── Enum types ────────────────────────────────────────────────────────
ALTER TYPE "PracticeTaskStatus"     RENAME TO "ControlTaskStatus";
ALTER TYPE "PracticeFrequency"      RENAME TO "ControlFrequency";
ALTER TYPE "PracticeMitigationType" RENAME TO "ControlMitigationType";
ALTER TYPE "PracticeStatus"         RENAME TO "ControlStatus";

-- ── Prisma bookkeeping ───────────────────────────────────────────────
-- Load-bearing; see the header. Without this, a later roll-forward sees
-- the rename as already applied and skips it, leaving new code on an old
-- schema.
DELETE FROM "_prisma_migrations"
 WHERE "migration_name" = '20260809120000_rename_control_to_practice';

COMMIT;
