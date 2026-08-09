-- ═══════════════════════════════════════════════════════════════════════
-- Rename Control → Practice
-- ═══════════════════════════════════════════════════════════════════════
--
-- HAND-WRITTEN, and it must stay that way. `prisma migrate diff` cannot
-- infer a rename: it proposes 166 statements that DROP every Control
-- table and CREATE a Practice one beside it, which silently discards
-- every row on a production database. Do not regenerate this file.
--
-- `ALTER TABLE … RENAME` is the opposite: it preserves the rows, and it
-- also carries the objects that hang off the table — RLS policies
-- (`tenant_isolation`, `superuser_bypass`), `relrowsecurity` /
-- `relforcerowsecurity`, indexes, constraints and triggers all follow
-- the table. That was verified against a live Postgres before this
-- migration was written; it is the reason a rename is safe here at all.
--
-- Index and constraint NAMES keep their old `Control_*` spelling. That is
-- cosmetic — Postgres addresses them by oid, Prisma never names them at
-- runtime, and renaming ~40 of them would add failure surface for no
-- behavioural gain. They show up as pre-existing drift, alongside the
-- drift this repo already carries.

-- ── Enum types ────────────────────────────────────────────────────────
ALTER TYPE "ControlStatus"         RENAME TO "PracticeStatus";
ALTER TYPE "ControlMitigationType" RENAME TO "PracticeMitigationType";
ALTER TYPE "ControlFrequency"      RENAME TO "PracticeFrequency";
ALTER TYPE "ControlTaskStatus"     RENAME TO "PracticeTaskStatus";

-- ── Tables ────────────────────────────────────────────────────────────
ALTER TABLE "Control"               RENAME TO "Practice";
ALTER TABLE "ControlAsset"          RENAME TO "PracticeAsset";
ALTER TABLE "ControlTask"           RENAME TO "PracticeTask";
ALTER TABLE "ControlEvidenceLink"   RENAME TO "PracticeEvidenceLink";
ALTER TABLE "ControlRequirementLink" RENAME TO "PracticeRequirementLink";
ALTER TABLE "ControlKeySequence"    RENAME TO "PracticeKeySequence";
ALTER TABLE "PolicyControlLink"     RENAME TO "PolicyPracticeLink";
ALTER TABLE "ProcessEdgeControl"    RENAME TO "ProcessEdgePractice";

-- ── Columns: the controlId foreign keys ───────────────────────────────
ALTER TABLE "PracticeAsset"           RENAME COLUMN "controlId" TO "practiceId";
ALTER TABLE "PracticeTask"            RENAME COLUMN "controlId" TO "practiceId";
ALTER TABLE "PracticeEvidenceLink"    RENAME COLUMN "controlId" TO "practiceId";
ALTER TABLE "PracticeRequirementLink" RENAME COLUMN "controlId" TO "practiceId";
ALTER TABLE "PolicyPracticeLink"      RENAME COLUMN "controlId" TO "practiceId";
ALTER TABLE "ProcessEdgePractice"     RENAME COLUMN "controlId" TO "practiceId";
ALTER TABLE "ProcessEdgePractice"     RENAME COLUMN "controlKey" TO "practiceKey";
ALTER TABLE "Evidence"                RENAME COLUMN "controlId" TO "practiceId";
ALTER TABLE "Task"                    RENAME COLUMN "controlId" TO "practiceId";
ALTER TABLE "IntegrationExecution"    RENAME COLUMN "controlId" TO "practiceId";
ALTER TABLE "FrameworkMapping"        RENAME COLUMN "toControlId" TO "toPracticeId";
ALTER TABLE "Finding"                 RENAME COLUMN "controlId" TO "practiceId";
ALTER TABLE "Finding"                 RENAME COLUMN "compensatingControlId" TO "compensatingPracticeId";

-- ── Columns: the ComplianceSnapshot rollup counters ───────────────────
ALTER TABLE "ComplianceSnapshot" RENAME COLUMN "controlsTotal"       TO "practicesTotal";
ALTER TABLE "ComplianceSnapshot" RENAME COLUMN "controlsImplemented" TO "practicesImplemented";
ALTER TABLE "ComplianceSnapshot" RENAME COLUMN "controlsInProgress"  TO "practicesInProgress";
ALTER TABLE "ComplianceSnapshot" RENAME COLUMN "controlsNotStarted"  TO "practicesNotStarted";
ALTER TABLE "ComplianceSnapshot" RENAME COLUMN "controlsApplicable"  TO "practicesApplicable";
ALTER TABLE "ComplianceSnapshot" RENAME COLUMN "controlCoverageBps"  TO "practiceCoverageBps";

-- ── Index + constraint names ─────────────────────────────────────────
-- Metadata only. `ALTER TABLE … RENAME` above carried these objects onto
-- the renamed tables but left them spelled `Control_*`; Postgres does not
-- care (it addresses them by oid) but `migrate diff` reports 69
-- statements of drift forever if they are left. These statements are the
-- ones Prisma itself generated for that diff, so applying them here makes
-- the rename leave ZERO residual drift of its own.
ALTER TABLE "Evidence" RENAME CONSTRAINT "Evidence_controlId_fkey" TO "Evidence_practiceId_fkey";
ALTER TABLE "Finding" RENAME CONSTRAINT "Finding_compensatingControlId_fkey" TO "Finding_compensatingPracticeId_fkey";
ALTER TABLE "Finding" RENAME CONSTRAINT "Finding_controlId_fkey" TO "Finding_practiceId_fkey";
ALTER TABLE "FrameworkMapping" RENAME CONSTRAINT "FrameworkMapping_toControlId_fkey" TO "FrameworkMapping_toPracticeId_fkey";
ALTER TABLE "IntegrationExecution" RENAME CONSTRAINT "IntegrationExecution_controlId_fkey" TO "IntegrationExecution_practiceId_fkey";
ALTER TABLE "PolicyPracticeLink" RENAME CONSTRAINT "PolicyControlLink_controlId_fkey" TO "PolicyPracticeLink_practiceId_fkey";
ALTER TABLE "PolicyPracticeLink" RENAME CONSTRAINT "PolicyControlLink_policyId_tenantId_fkey" TO "PolicyPracticeLink_policyId_tenantId_fkey";
ALTER TABLE "PolicyPracticeLink" RENAME CONSTRAINT "PolicyControlLink_tenantId_fkey" TO "PolicyPracticeLink_tenantId_fkey";
ALTER TABLE "Practice" RENAME CONSTRAINT "Control_applicabilityDecidedByUserId_fkey" TO "Practice_applicabilityDecidedByUserId_fkey";
ALTER TABLE "Practice" RENAME CONSTRAINT "Control_createdByUserId_fkey" TO "Practice_createdByUserId_fkey";
ALTER TABLE "Practice" RENAME CONSTRAINT "Control_ownerUserId_fkey" TO "Practice_ownerUserId_fkey";
ALTER TABLE "Practice" RENAME CONSTRAINT "Control_tenantId_fkey" TO "Practice_tenantId_fkey";
ALTER TABLE "PracticeAsset" RENAME CONSTRAINT "ControlAsset_assetId_fkey" TO "PracticeAsset_assetId_fkey";
ALTER TABLE "PracticeAsset" RENAME CONSTRAINT "ControlAsset_controlId_fkey" TO "PracticeAsset_practiceId_fkey";
ALTER TABLE "PracticeAsset" RENAME CONSTRAINT "ControlAsset_createdByUserId_fkey" TO "PracticeAsset_createdByUserId_fkey";
ALTER TABLE "PracticeAsset" RENAME CONSTRAINT "ControlAsset_tenantId_fkey" TO "PracticeAsset_tenantId_fkey";
ALTER TABLE "PracticeEvidenceLink" RENAME CONSTRAINT "ControlEvidenceLink_controlId_fkey" TO "PracticeEvidenceLink_practiceId_fkey";
ALTER TABLE "PracticeEvidenceLink" RENAME CONSTRAINT "ControlEvidenceLink_createdByUserId_fkey" TO "PracticeEvidenceLink_createdByUserId_fkey";
ALTER TABLE "PracticeEvidenceLink" RENAME CONSTRAINT "ControlEvidenceLink_tenantId_fkey" TO "PracticeEvidenceLink_tenantId_fkey";
ALTER TABLE "PracticeRequirementLink" RENAME CONSTRAINT "ControlRequirementLink_controlId_fkey" TO "PracticeRequirementLink_practiceId_fkey";
ALTER TABLE "PracticeRequirementLink" RENAME CONSTRAINT "ControlRequirementLink_requirementId_fkey" TO "PracticeRequirementLink_requirementId_fkey";
ALTER TABLE "PracticeRequirementLink" RENAME CONSTRAINT "ControlRequirementLink_tenantId_fkey" TO "PracticeRequirementLink_tenantId_fkey";
ALTER TABLE "PracticeTask" RENAME CONSTRAINT "ControlTask_assigneeUserId_fkey" TO "PracticeTask_assigneeUserId_fkey";
ALTER TABLE "PracticeTask" RENAME CONSTRAINT "ControlTask_controlId_fkey" TO "PracticeTask_practiceId_fkey";
ALTER TABLE "PracticeTask" RENAME CONSTRAINT "ControlTask_tenantId_fkey" TO "PracticeTask_tenantId_fkey";
ALTER TABLE "ProcessEdgePractice" RENAME CONSTRAINT "ProcessEdgeControl_edgeId_tenantId_fkey" TO "ProcessEdgePractice_edgeId_tenantId_fkey";
ALTER TABLE "ProcessEdgePractice" RENAME CONSTRAINT "ProcessEdgeControl_tenantId_fkey" TO "ProcessEdgePractice_tenantId_fkey";
ALTER TABLE "Task" RENAME CONSTRAINT "Task_controlId_fkey" TO "Task_practiceId_fkey";
ALTER INDEX "Evidence_tenantId_controlId_idx" RENAME TO "Evidence_tenantId_practiceId_idx";
ALTER INDEX "Evidence_tenantId_sourceLogEntryId_controlId_key" RENAME TO "Evidence_tenantId_sourceLogEntryId_practiceId_key";
ALTER INDEX "Finding_tenantId_compensatingControlId_idx" RENAME TO "Finding_tenantId_compensatingPracticeId_idx";
ALTER INDEX "Finding_tenantId_controlId_idx" RENAME TO "Finding_tenantId_practiceId_idx";
ALTER INDEX "FrameworkMapping_fromRequirementId_toControlId_key" RENAME TO "FrameworkMapping_fromRequirementId_toPracticeId_key";
ALTER INDEX "IntegrationExecution_tenantId_controlId_idx" RENAME TO "IntegrationExecution_tenantId_practiceId_idx";
ALTER INDEX "MarketPriceSeries_source_commodity_region_stage_currency_unit_k" RENAME TO "MarketPriceSeries_source_commodity_region_stage_currency_un_key";
ALTER INDEX "PolicyControlLink_policyId_controlId_key" RENAME TO "PolicyPracticeLink_policyId_practiceId_key";
ALTER INDEX "PolicyControlLink_tenantId_controlId_idx" RENAME TO "PolicyPracticeLink_tenantId_practiceId_idx";
ALTER INDEX "PolicyControlLink_tenantId_idx" RENAME TO "PolicyPracticeLink_tenantId_idx";
ALTER INDEX "PolicyControlLink_tenantId_policyId_idx" RENAME TO "PolicyPracticeLink_tenantId_policyId_idx";
ALTER INDEX "Control_id_tenantId_key" RENAME TO "Practice_id_tenantId_key";
ALTER INDEX "Control_nextDueAt_idx" RENAME TO "Practice_nextDueAt_idx";
ALTER INDEX "Control_ownerUserId_idx" RENAME TO "Practice_ownerUserId_idx";
ALTER INDEX "Control_tenantId_applicability_idx" RENAME TO "Practice_tenantId_applicability_idx";
ALTER INDEX "Control_tenantId_category_idx" RENAME TO "Practice_tenantId_category_idx";
ALTER INDEX "Control_tenantId_code_idx" RENAME TO "Practice_tenantId_code_idx";
ALTER INDEX "Control_tenantId_createdAt_idx" RENAME TO "Practice_tenantId_createdAt_idx";
ALTER INDEX "Control_tenantId_deletedAt_idx" RENAME TO "Practice_tenantId_deletedAt_idx";
ALTER INDEX "Control_tenantId_idx" RENAME TO "Practice_tenantId_idx";
ALTER INDEX "Control_tenantId_ownerUserId_idx" RENAME TO "Practice_tenantId_ownerUserId_idx";
ALTER INDEX "Control_tenantId_status_idx" RENAME TO "Practice_tenantId_status_idx";
ALTER INDEX "ControlAsset_tenantId_assetId_idx" RENAME TO "PracticeAsset_tenantId_assetId_idx";
ALTER INDEX "ControlAsset_tenantId_controlId_assetId_key" RENAME TO "PracticeAsset_tenantId_practiceId_assetId_key";
ALTER INDEX "ControlAsset_tenantId_idx" RENAME TO "PracticeAsset_tenantId_idx";
ALTER INDEX "ControlEvidenceLink_controlId_idx" RENAME TO "PracticeEvidenceLink_practiceId_idx";
ALTER INDEX "ControlEvidenceLink_controlId_kind_fileId_key" RENAME TO "PracticeEvidenceLink_practiceId_kind_fileId_key";
ALTER INDEX "ControlEvidenceLink_controlId_kind_url_key" RENAME TO "PracticeEvidenceLink_practiceId_kind_url_key";
ALTER INDEX "ControlEvidenceLink_tenantId_idx" RENAME TO "PracticeEvidenceLink_tenantId_idx";
ALTER INDEX "ControlRequirementLink_controlId_requirementId_key" RENAME TO "PracticeRequirementLink_practiceId_requirementId_key";
ALTER INDEX "ControlRequirementLink_tenantId_requirementId_idx" RENAME TO "PracticeRequirementLink_tenantId_requirementId_idx";
ALTER INDEX "ControlTask_controlId_idx" RENAME TO "PracticeTask_practiceId_idx";
ALTER INDEX "ControlTask_dueAt_idx" RENAME TO "PracticeTask_dueAt_idx";
ALTER INDEX "ControlTask_status_idx" RENAME TO "PracticeTask_status_idx";
ALTER INDEX "ControlTask_tenantId_idx" RENAME TO "PracticeTask_tenantId_idx";
ALTER INDEX "ControlTask_tenantId_status_dueAt_idx" RENAME TO "PracticeTask_tenantId_status_dueAt_idx";
ALTER INDEX "ProcessEdgeControl_edgeId_controlKey_key" RENAME TO "ProcessEdgePractice_edgeId_practiceKey_key";
ALTER INDEX "ProcessEdgeControl_tenantId_controlId_idx" RENAME TO "ProcessEdgePractice_tenantId_practiceId_idx";
ALTER INDEX "ProcessEdgeControl_tenantId_processMapId_idx" RENAME TO "ProcessEdgePractice_tenantId_processMapId_idx";
ALTER INDEX "Task_tenantId_controlId_idx" RENAME TO "Task_tenantId_practiceId_idx";
ALTER INDEX "Task_tenantId_controlId_status_idx" RENAME TO "Task_tenantId_practiceId_status_idx";

-- Primary-key constraint names (same rationale as the block above).
ALTER TABLE "PolicyPracticeLink" RENAME CONSTRAINT "PolicyControlLink_pkey" TO "PolicyPracticeLink_pkey";
ALTER TABLE "Practice" RENAME CONSTRAINT "Control_pkey" TO "Practice_pkey";
ALTER TABLE "PracticeAsset" RENAME CONSTRAINT "ControlAsset_pkey" TO "PracticeAsset_pkey";
ALTER TABLE "PracticeEvidenceLink" RENAME CONSTRAINT "ControlEvidenceLink_pkey" TO "PracticeEvidenceLink_pkey";
ALTER TABLE "PracticeKeySequence" RENAME CONSTRAINT "ControlKeySequence_pkey" TO "PracticeKeySequence_pkey";
ALTER TABLE "PracticeRequirementLink" RENAME CONSTRAINT "ControlRequirementLink_pkey" TO "PracticeRequirementLink_pkey";
ALTER TABLE "PracticeTask" RENAME CONSTRAINT "ControlTask_pkey" TO "PracticeTask_pkey";
ALTER TABLE "ProcessEdgePractice" RENAME CONSTRAINT "ProcessEdgeControl_pkey" TO "ProcessEdgePractice_pkey";
