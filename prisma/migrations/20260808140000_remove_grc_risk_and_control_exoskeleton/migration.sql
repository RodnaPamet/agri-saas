-- ═══════════════════════════════════════════════════════════════════════
-- Remove the inherited GRC risk stack + control exoskeleton
-- ═══════════════════════════════════════════════════════════════════════
--
-- The schema half of the uproot that removed the risk register, the
-- risk-quantification layer (FAIR / Monte-Carlo / appetite / KRI /
-- bow-tie / correlation / trending) and the control template + testing
-- exoskeleton inherited from inflect-compliance. None of it belongs in an
-- agriculture product, and by this point none of it had a reachable
-- caller — the pages, routes, usecases, jobs and UI went in the commits
-- leading up to this one.
--
-- DESTRUCTIVE — read before applying:
--   • 36 tables dropped. On the agrent production stack these hold real
--     inherited rows; the data is intentionally discarded, not migrated.
--   • `Control` loses annexId / annualCost / automationType / lastTested.
--     `annexId` was the ISO Annex-A code; `code` is the surviving column
--     and the seed + repository already read it.
--   • `ComplianceSnapshot` loses its nine `risks*` columns. The snapshot
--     job had already been writing literal zeros into them.
--   • `AgroSignal.riskId` / `Evidence.riskId` — back-links to a dropped
--     table.
--   • Three enums lose their `RISK` member (ModuleKey,
--     TaskLinkEntityType, VendorLinkEntityType). Prisma renders these as
--     a type swap that casts every existing value through the new type,
--     so a surviving row holding `RISK` would abort the migration. The
--     pre-flight below clears them first.
--
-- SCOPE NOTE. This was generated with `prisma migrate diff
-- --from-config-datasource --to-schema prisma/schema --script` against a
-- database built by `migrate deploy` from every preceding migration, and
-- then FILTERED to the risk/control statements only. The raw diff also
-- emitted ~30 statements of pre-existing schema↔database drift that have
-- nothing to do with this change and were deliberately excluded (the
-- exact count moves as `main` evolves — it was 31 when this migration
-- was written and 30 after merging main at 2a6ffe55) — most
-- importantly `ALTER TABLE "User" ALTER COLUMN "emailHash" DROP NOT
-- NULL`, which would have silently reverted the GAP-21 hardening, plus
-- the hand-written `KnowledgeChunk_embedding_ivfflat` and
-- `Parcel_geometry_gist` indexes and the `YieldRecord.netTonnesStd`
-- generated column, none of which Prisma can model. That drift is real
-- and worth a separate look; it is not this migration's business.

-- ── Pre-flight: clear rows holding an enum value about to be removed ──
-- A TaskLink/VendorLink row still pointing at a Risk cannot cast to the
-- new enum, and its target is dropped below, so the link is dead either
-- way. `TenantModuleSettings.enabledModules` is an ARRAY — strip the
-- member rather than deleting the tenant's settings row.
DELETE FROM "TaskLink" WHERE "entityType" = 'RISK';
DELETE FROM "VendorLink" WHERE "entityType" = 'RISK';
UPDATE "TenantModuleSettings"
   SET "enabledModules" = array_remove("enabledModules", 'RISK')
 WHERE 'RISK' = ANY("enabledModules");

-- AlterEnum
BEGIN;
CREATE TYPE "ModuleKey_new" AS ENUM ('JOURNAL', 'INVENTORY', 'PLANNING', 'CERTIFICATION', 'VENDORS', 'AUTOMATION', 'PROCESSES', 'AI', 'GRAIN', 'EXCHANGE');
ALTER TABLE "TenantModuleSettings" ALTER COLUMN "enabledModules" TYPE "ModuleKey_new"[] USING ("enabledModules"::text::"ModuleKey_new"[]);
ALTER TYPE "ModuleKey" RENAME TO "ModuleKey_old";
ALTER TYPE "ModuleKey_new" RENAME TO "ModuleKey";
DROP TYPE "public"."ModuleKey_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "TaskLinkEntityType_new" AS ENUM ('CONTROL', 'FRAMEWORK_REQUIREMENT', 'ASSET', 'POLICY', 'EVIDENCE', 'FILE', 'AUDIT_PACK', 'VENDOR', 'LOCATION', 'PARCEL', 'EQUIPMENT', 'PLANTING');
ALTER TABLE "TaskLink" ALTER COLUMN "entityType" TYPE "TaskLinkEntityType_new" USING ("entityType"::text::"TaskLinkEntityType_new");
ALTER TYPE "TaskLinkEntityType" RENAME TO "TaskLinkEntityType_old";
ALTER TYPE "TaskLinkEntityType_new" RENAME TO "TaskLinkEntityType";
DROP TYPE "public"."TaskLinkEntityType_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "VendorLinkEntityType_new" AS ENUM ('ASSET', 'ISSUE', 'CONTROL');
ALTER TABLE "VendorLink" ALTER COLUMN "entityType" TYPE "VendorLinkEntityType_new" USING ("entityType"::text::"VendorLinkEntityType_new");
ALTER TYPE "VendorLinkEntityType" RENAME TO "VendorLinkEntityType_old";
ALTER TYPE "VendorLinkEntityType_new" RENAME TO "VendorLinkEntityType";
DROP TYPE "public"."VendorLinkEntityType_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "AgroSignal" DROP CONSTRAINT "AgroSignal_riskId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AssetRiskLink" DROP CONSTRAINT "AssetRiskLink_assetId_fkey";

-- DropForeignKey
ALTER TABLE "AssetRiskLink" DROP CONSTRAINT "AssetRiskLink_createdByUserId_fkey";

-- DropForeignKey
ALTER TABLE "AssetRiskLink" DROP CONSTRAINT "AssetRiskLink_riskId_fkey";

-- DropForeignKey
ALTER TABLE "AssetRiskLink" DROP CONSTRAINT "AssetRiskLink_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ControlContributor" DROP CONSTRAINT "ControlContributor_controlId_fkey";

-- DropForeignKey
ALTER TABLE "ControlContributor" DROP CONSTRAINT "ControlContributor_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ControlContributor" DROP CONSTRAINT "ControlContributor_userId_fkey";

-- DropForeignKey
ALTER TABLE "ControlException" DROP CONSTRAINT "ControlException_approvedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "ControlException" DROP CONSTRAINT "ControlException_compensatingControlId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ControlException" DROP CONSTRAINT "ControlException_controlId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ControlException" DROP CONSTRAINT "ControlException_createdByUserId_fkey";

-- DropForeignKey
ALTER TABLE "ControlException" DROP CONSTRAINT "ControlException_deletedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "ControlException" DROP CONSTRAINT "ControlException_rejectedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "ControlException" DROP CONSTRAINT "ControlException_renewedFromId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ControlException" DROP CONSTRAINT "ControlException_riskAcceptedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "ControlException" DROP CONSTRAINT "ControlException_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ControlTemplateRequirementLink" DROP CONSTRAINT "ControlTemplateRequirementLink_requirementId_fkey";

-- DropForeignKey
ALTER TABLE "ControlTemplateRequirementLink" DROP CONSTRAINT "ControlTemplateRequirementLink_templateId_fkey";

-- DropForeignKey
ALTER TABLE "ControlTemplateTask" DROP CONSTRAINT "ControlTemplateTask_templateId_fkey";

-- DropForeignKey
ALTER TABLE "ControlTestEvidenceLink" DROP CONSTRAINT "ControlTestEvidenceLink_createdByUserId_fkey";

-- DropForeignKey
ALTER TABLE "ControlTestEvidenceLink" DROP CONSTRAINT "ControlTestEvidenceLink_evidenceId_fkey";

-- DropForeignKey
ALTER TABLE "ControlTestEvidenceLink" DROP CONSTRAINT "ControlTestEvidenceLink_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ControlTestEvidenceLink" DROP CONSTRAINT "ControlTestEvidenceLink_testRunId_fkey";

-- DropForeignKey
ALTER TABLE "ControlTestPlan" DROP CONSTRAINT "ControlTestPlan_controlId_fkey";

-- DropForeignKey
ALTER TABLE "ControlTestPlan" DROP CONSTRAINT "ControlTestPlan_createdByUserId_fkey";

-- DropForeignKey
ALTER TABLE "ControlTestPlan" DROP CONSTRAINT "ControlTestPlan_ownerUserId_fkey";

-- DropForeignKey
ALTER TABLE "ControlTestPlan" DROP CONSTRAINT "ControlTestPlan_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ControlTestRun" DROP CONSTRAINT "ControlTestRun_controlId_fkey";

-- DropForeignKey
ALTER TABLE "ControlTestRun" DROP CONSTRAINT "ControlTestRun_createdByUserId_fkey";

-- DropForeignKey
ALTER TABLE "ControlTestRun" DROP CONSTRAINT "ControlTestRun_executedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "ControlTestRun" DROP CONSTRAINT "ControlTestRun_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ControlTestRun" DROP CONSTRAINT "ControlTestRun_testPlanId_fkey";

-- DropForeignKey
ALTER TABLE "ControlTestStep" DROP CONSTRAINT "ControlTestStep_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ControlTestStep" DROP CONSTRAINT "ControlTestStep_testPlanId_fkey";

-- DropForeignKey
ALTER TABLE "Evidence" DROP CONSTRAINT "Evidence_riskId_fkey";

-- DropForeignKey
ALTER TABLE "FindingRisk" DROP CONSTRAINT "FindingRisk_findingId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "FindingRisk" DROP CONSTRAINT "FindingRisk_riskId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "FindingRisk" DROP CONSTRAINT "FindingRisk_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "KeyRiskIndicator" DROP CONSTRAINT "KeyRiskIndicator_ownerUserId_fkey";

-- DropForeignKey
ALTER TABLE "KeyRiskIndicator" DROP CONSTRAINT "KeyRiskIndicator_riskId_fkey";

-- DropForeignKey
ALTER TABLE "KeyRiskIndicator" DROP CONSTRAINT "KeyRiskIndicator_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "KriReading" DROP CONSTRAINT "KriReading_kriId_fkey";

-- DropForeignKey
ALTER TABLE "KriReading" DROP CONSTRAINT "KriReading_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "LossEvent" DROP CONSTRAINT "LossEvent_riskId_fkey";

-- DropForeignKey
ALTER TABLE "LossEvent" DROP CONSTRAINT "LossEvent_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "PackTemplateLink" DROP CONSTRAINT "PackTemplateLink_packId_fkey";

-- DropForeignKey
ALTER TABLE "PackTemplateLink" DROP CONSTRAINT "PackTemplateLink_templateId_fkey";

-- DropForeignKey
ALTER TABLE "PortfolioSnapshot" DROP CONSTRAINT "PortfolioSnapshot_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ReportRun" DROP CONSTRAINT "ReportRun_templateId_fkey";

-- DropForeignKey
ALTER TABLE "ReportRun" DROP CONSTRAINT "ReportRun_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ReportSchedule" DROP CONSTRAINT "ReportSchedule_templateId_fkey";

-- DropForeignKey
ALTER TABLE "ReportSchedule" DROP CONSTRAINT "ReportSchedule_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ReportTemplate" DROP CONSTRAINT "ReportTemplate_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Risk" DROP CONSTRAINT "Risk_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "RiskAppetiteBreach" DROP CONSTRAINT "RiskAppetiteBreach_riskId_fkey";

-- DropForeignKey
ALTER TABLE "RiskAppetiteBreach" DROP CONSTRAINT "RiskAppetiteBreach_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "RiskAppetiteConfig" DROP CONSTRAINT "RiskAppetiteConfig_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "RiskControl" DROP CONSTRAINT "RiskControl_controlId_fkey";

-- DropForeignKey
ALTER TABLE "RiskControl" DROP CONSTRAINT "RiskControl_createdByUserId_fkey";

-- DropForeignKey
ALTER TABLE "RiskControl" DROP CONSTRAINT "RiskControl_riskId_fkey";

-- DropForeignKey
ALTER TABLE "RiskControl" DROP CONSTRAINT "RiskControl_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "RiskCorrelation" DROP CONSTRAINT "RiskCorrelation_riskAId_fkey";

-- DropForeignKey
ALTER TABLE "RiskCorrelation" DROP CONSTRAINT "RiskCorrelation_riskBId_fkey";

-- DropForeignKey
ALTER TABLE "RiskCorrelation" DROP CONSTRAINT "RiskCorrelation_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "RiskHierarchyLink" DROP CONSTRAINT "RiskHierarchyLink_nodeId_fkey";

-- DropForeignKey
ALTER TABLE "RiskHierarchyLink" DROP CONSTRAINT "RiskHierarchyLink_riskId_fkey";

-- DropForeignKey
ALTER TABLE "RiskHierarchyLink" DROP CONSTRAINT "RiskHierarchyLink_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "RiskHierarchyNode" DROP CONSTRAINT "RiskHierarchyNode_parentId_fkey";

-- DropForeignKey
ALTER TABLE "RiskHierarchyNode" DROP CONSTRAINT "RiskHierarchyNode_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "RiskMatrixConfig" DROP CONSTRAINT "RiskMatrixConfig_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "RiskScenario" DROP CONSTRAINT "RiskScenario_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "RiskScoreEvent" DROP CONSTRAINT "RiskScoreEvent_riskId_fkey";

-- DropForeignKey
ALTER TABLE "RiskScoreEvent" DROP CONSTRAINT "RiskScoreEvent_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "RiskSimulationRun" DROP CONSTRAINT "RiskSimulationRun_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "RiskSnapshot" DROP CONSTRAINT "RiskSnapshot_riskId_fkey";

-- DropForeignKey
ALTER TABLE "RiskSnapshot" DROP CONSTRAINT "RiskSnapshot_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "RiskSuggestionItem" DROP CONSTRAINT "RiskSuggestionItem_assetId_fkey";

-- DropForeignKey
ALTER TABLE "RiskSuggestionItem" DROP CONSTRAINT "RiskSuggestionItem_sessionId_fkey";

-- DropForeignKey
ALTER TABLE "RiskSuggestionItem" DROP CONSTRAINT "RiskSuggestionItem_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "RiskSuggestionSession" DROP CONSTRAINT "RiskSuggestionSession_createdByUserId_fkey";

-- DropForeignKey
ALTER TABLE "RiskSuggestionSession" DROP CONSTRAINT "RiskSuggestionSession_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "RiskTreatmentPlan" DROP CONSTRAINT "RiskTreatmentPlan_completedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "RiskTreatmentPlan" DROP CONSTRAINT "RiskTreatmentPlan_createdByUserId_fkey";

-- DropForeignKey
ALTER TABLE "RiskTreatmentPlan" DROP CONSTRAINT "RiskTreatmentPlan_deletedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "RiskTreatmentPlan" DROP CONSTRAINT "RiskTreatmentPlan_ownerUserId_fkey";

-- DropForeignKey
ALTER TABLE "RiskTreatmentPlan" DROP CONSTRAINT "RiskTreatmentPlan_riskId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "RiskTreatmentPlan" DROP CONSTRAINT "RiskTreatmentPlan_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "TreatmentMilestone" DROP CONSTRAINT "TreatmentMilestone_treatmentPlanId_tenantId_fkey";

-- DropIndex
DROP INDEX "AgroSignal_tenantId_riskId_idx";

-- DropIndex
DROP INDEX "Control_annexId_key";

-- DropIndex
DROP INDEX "Evidence_tenantId_riskId_idx";

-- AlterTable
ALTER TABLE "AgroSignal" DROP COLUMN "riskId";

-- AlterTable
ALTER TABLE "ComplianceSnapshot" DROP COLUMN "risksAccepted",
DROP COLUMN "risksClosed",
DROP COLUMN "risksCritical",
DROP COLUMN "risksHigh",
DROP COLUMN "risksLow",
DROP COLUMN "risksMedium",
DROP COLUMN "risksMitigating",
DROP COLUMN "risksOpen",
DROP COLUMN "risksTotal";

-- AlterTable
ALTER TABLE "Control" DROP COLUMN "annexId",
DROP COLUMN "annualCost",
DROP COLUMN "automationType",
DROP COLUMN "lastTested";

-- AlterTable
ALTER TABLE "Evidence" DROP COLUMN "riskId";

-- DropTable
DROP TABLE "AssetRiskLink";

-- DropTable
DROP TABLE "ControlContributor";

-- DropTable
DROP TABLE "ControlException";

-- DropTable
DROP TABLE "ControlTemplate";

-- DropTable
DROP TABLE "ControlTemplateRequirementLink";

-- DropTable
DROP TABLE "ControlTemplateTask";

-- DropTable
DROP TABLE "ControlTestEvidenceLink";

-- DropTable
DROP TABLE "ControlTestPlan";

-- DropTable
DROP TABLE "ControlTestRun";

-- DropTable
DROP TABLE "ControlTestStep";

-- DropTable
DROP TABLE "FindingRisk";

-- DropTable
DROP TABLE "KeyRiskIndicator";

-- DropTable
DROP TABLE "KriReading";

-- DropTable
DROP TABLE "LossEvent";

-- DropTable
DROP TABLE "PackTemplateLink";

-- DropTable
DROP TABLE "PortfolioSnapshot";

-- DropTable
DROP TABLE "ReportRun";

-- DropTable
DROP TABLE "ReportSchedule";

-- DropTable
DROP TABLE "ReportTemplate";

-- DropTable
DROP TABLE "Risk";

-- DropTable
DROP TABLE "RiskAppetiteBreach";

-- DropTable
DROP TABLE "RiskAppetiteConfig";

-- DropTable
DROP TABLE "RiskControl";

-- DropTable
DROP TABLE "RiskCorrelation";

-- DropTable
DROP TABLE "RiskHierarchyLink";

-- DropTable
DROP TABLE "RiskHierarchyNode";

-- DropTable
DROP TABLE "RiskKeySequence";

-- DropTable
DROP TABLE "RiskMatrixConfig";

-- DropTable
DROP TABLE "RiskScenario";

-- DropTable
DROP TABLE "RiskScoreEvent";

-- DropTable
DROP TABLE "RiskSimulationRun";

-- DropTable
DROP TABLE "RiskSnapshot";

-- DropTable
DROP TABLE "RiskSuggestionItem";

-- DropTable
DROP TABLE "RiskSuggestionSession";

-- DropTable
DROP TABLE "RiskTemplate";

-- DropTable
DROP TABLE "RiskTreatmentPlan";

-- DropEnum
DROP TYPE "ControlAutomationType";

-- DropEnum
DROP TYPE "ControlExceptionStatus";

-- DropEnum
DROP TYPE "TestEvidenceKind";

-- DropEnum
DROP TYPE "TestMethod";

-- DropEnum
DROP TYPE "TestPlanStatus";

-- DropEnum
DROP TYPE "TestResult";

-- DropEnum
DROP TYPE "TestRunStatus";
