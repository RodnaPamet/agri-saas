-- GRC teardown phase 3 — drop the inherited compliance/vendor/audit schema.
--
-- This codebase was spun out of a GRC SaaS. Phases 1 and 2 moved the
-- load-bearing agri models out of the GRC schema files and then deleted
-- every line of application code that touched the GRC surface. This
-- migration removes the tables, enums and columns that code used to
-- read. See docs/implementation-notes/2026-08-12-grc-teardown-plan.md.
--
-- 47 tables, 44 enums, 7 indexes, 5 columns on surviving tables, plus
-- dead values narrowed out of 4 enums that are still in use.
--
-- PRODUCTION PRE-FLIGHT (measured on inflect_production, 2026-08-15):
-- all 47 dropped tables held 0 rows, and 0 of the 3,143 rows across
-- Task / TaskLink / Notification carried any of the enum values this
-- migration removes. There is no data to migrate.
--
-- ROLLBACK: deploy/rollback/20260815120000_grc_teardown_phase3.down.sql.
-- It is REQUIRED, not optional — the previous image's Prisma client
-- still SELECTs the five dropped columns from Evidence / Task /
-- IntegrationExecution / ProcessEdgePractice / AssetMaintenance, so
-- pinning Watchtower back without running the inverse leaves the old
-- image querying columns that no longer exist.

-- ─── Defensive pre-flight ────────────────────────────────────────────
--
-- The enum narrowings below use `USING (col::text::NewEnum)`, which
-- aborts the whole migration on the first row holding a removed value.
-- Production measured zero such rows and nothing in the phase-2
-- codebase can write one, so these four statements are no-ops today.
-- They exist because "measured zero last week" and "zero at deploy
-- time" are different claims, and the failure they prevent is a
-- half-applied deploy at an unhelpful hour rather than a data problem.
--
-- Each disposition is chosen for what the row would MEAN, not for
-- what is convenient: a Task keeps its identity under a generic type,
-- while a TaskLink or a Notification pointing at a deleted entity is
-- garbage and is removed rather than relabelled onto something real.
UPDATE "Task" SET "type" = 'TASK'
 WHERE "type"::text IN ('AUDIT_FINDING', 'PRACTICE_GAP', 'INCIDENT');

DELETE FROM "TaskLink"
 WHERE "entityType"::text IN ('PRACTICE', 'FRAMEWORK_REQUIREMENT', 'POLICY', 'AUDIT_PACK', 'VENDOR');

DELETE FROM "Notification"
 WHERE "type"::text IN ('POLICY_APPROVAL_NEEDED', 'POLICY_ACKNOWLEDGED', 'FINDING_ASSIGNED',
                        'FINDING_VERIFIED', 'PRACTICE_ASSIGNED', 'RISK_ASSIGNED', 'VENDOR_REVIEW_DUE');

UPDATE "TenantModuleSettings"
   SET "enabledModules" = array_remove("enabledModules"::text[], 'VENDORS')::"ModuleKey"[]
 WHERE 'VENDORS' = ANY("enabledModules"::text[]);


-- ─── RLS policies that outlive their subject ─────────────────────────
--
-- Prisma's schema diff does not know Row-Level Security exists, so the
-- generated DROP TABLE statements below do not account for policies
-- whose USING / WITH CHECK expression SUBQUERIES another table. Postgres
-- refuses to drop a table while such a policy points at it:
--
--   ERROR: cannot drop table "Practice" because other objects depend on it
--   DETAIL: policy control_parent_tenant_check on table "PolicyPracticeLink"
--
-- Both policies below sit on tables this migration also drops, so this
-- is purely an ORDERING fix — nothing survives that would have lost its
-- isolation. Dropping them by name rather than reaching for DROP TABLE
-- ... CASCADE is deliberate: CASCADE would also silently remove any
-- policy on a SURVIVING table that happened to reference a dropped one,
-- which is exactly the class of change that must not happen quietly.
DROP POLICY IF EXISTS "control_parent_tenant_check" ON "PolicyPracticeLink";
DROP POLICY IF EXISTS "tenant_isolation" ON "PolicyAcknowledgement";

-- AlterEnum
BEGIN;
CREATE TYPE "WorkItemType_new" AS ENUM ('IMPROVEMENT', 'TASK', 'FIELD_OPERATION', 'FARM_TASK');
ALTER TABLE "Task" ALTER COLUMN "type" DROP DEFAULT;
ALTER TABLE "Task" ALTER COLUMN "type" TYPE "WorkItemType_new" USING ("type"::text::"WorkItemType_new");
ALTER TYPE "WorkItemType" RENAME TO "WorkItemType_old";
ALTER TYPE "WorkItemType_new" RENAME TO "WorkItemType";
DROP TYPE "WorkItemType_old";
ALTER TABLE "Task" ALTER COLUMN "type" SET DEFAULT 'TASK';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "TaskLinkEntityType_new" AS ENUM ('ASSET', 'EVIDENCE', 'FILE', 'LOCATION', 'PARCEL', 'EQUIPMENT', 'PLANTING');
ALTER TABLE "TaskLink" ALTER COLUMN "entityType" TYPE "TaskLinkEntityType_new" USING ("entityType"::text::"TaskLinkEntityType_new");
ALTER TYPE "TaskLinkEntityType" RENAME TO "TaskLinkEntityType_old";
ALTER TYPE "TaskLinkEntityType_new" RENAME TO "TaskLinkEntityType";
DROP TYPE "TaskLinkEntityType_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "NotificationType_new" AS ENUM ('EVIDENCE_DUE_SOON', 'EVIDENCE_OVERDUE', 'EVIDENCE_REJECTED', 'EVIDENCE_APPROVED', 'TASK_ASSIGNED', 'ASSET_ASSIGNED', 'TASK_DUE', 'LOW_STOCK', 'LEASE_EXPIRING', 'CONTRACT_DELIVERY_DUE', 'GENERAL');
ALTER TABLE "Notification" ALTER COLUMN "type" DROP DEFAULT;
ALTER TABLE "Notification" ALTER COLUMN "type" TYPE "NotificationType_new" USING ("type"::text::"NotificationType_new");
ALTER TYPE "NotificationType" RENAME TO "NotificationType_old";
ALTER TYPE "NotificationType_new" RENAME TO "NotificationType";
DROP TYPE "NotificationType_old";
ALTER TABLE "Notification" ALTER COLUMN "type" SET DEFAULT 'GENERAL';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "ModuleKey_new" AS ENUM ('JOURNAL', 'INVENTORY', 'PLANNING', 'CERTIFICATION', 'AUTOMATION', 'PROCESSES', 'AI', 'GRAIN', 'EXCHANGE');
ALTER TABLE "TenantModuleSettings" ALTER COLUMN "enabledModules" TYPE "ModuleKey_new"[] USING ("enabledModules"::text::"ModuleKey_new"[]);
ALTER TYPE "ModuleKey" RENAME TO "ModuleKey_old";
ALTER TYPE "ModuleKey_new" RENAME TO "ModuleKey";
DROP TYPE "ModuleKey_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "AssetMaintenance" DROP CONSTRAINT "AssetMaintenance_vendorId_fkey";

-- DropForeignKey
ALTER TABLE "Audit" DROP CONSTRAINT "Audit_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AuditChecklistItem" DROP CONSTRAINT "AuditChecklistItem_auditId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AuditChecklistItem" DROP CONSTRAINT "AuditChecklistItem_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AuditCycle" DROP CONSTRAINT "AuditCycle_createdByUserId_fkey";

-- DropForeignKey
ALTER TABLE "AuditCycle" DROP CONSTRAINT "AuditCycle_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AuditPack" DROP CONSTRAINT "AuditPack_auditCycleId_fkey";

-- DropForeignKey
ALTER TABLE "AuditPack" DROP CONSTRAINT "AuditPack_frozenByUserId_fkey";

-- DropForeignKey
ALTER TABLE "AuditPack" DROP CONSTRAINT "AuditPack_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AuditPackItem" DROP CONSTRAINT "AuditPackItem_auditPackId_fkey";

-- DropForeignKey
ALTER TABLE "AuditPackItem" DROP CONSTRAINT "AuditPackItem_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AuditPackShare" DROP CONSTRAINT "AuditPackShare_auditPackId_fkey";

-- DropForeignKey
ALTER TABLE "AuditPackShare" DROP CONSTRAINT "AuditPackShare_createdByUserId_fkey";

-- DropForeignKey
ALTER TABLE "AuditPackShare" DROP CONSTRAINT "AuditPackShare_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AuditorAccount" DROP CONSTRAINT "AuditorAccount_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AuditorPackAccess" DROP CONSTRAINT "AuditorPackAccess_auditPackId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AuditorPackAccess" DROP CONSTRAINT "AuditorPackAccess_auditorId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AuditorPackAccess" DROP CONSTRAINT "AuditorPackAccess_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ReadinessSnapshot" DROP CONSTRAINT "ReadinessSnapshot_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ReadinessSnapshot" DROP CONSTRAINT "ReadinessSnapshot_auditCycleId_fkey";

-- DropForeignKey
ALTER TABLE "IntegrationExecution" DROP CONSTRAINT "IntegrationExecution_practiceId_fkey";

-- DropForeignKey
ALTER TABLE "ClauseProgress" DROP CONSTRAINT "ClauseProgress_clauseId_fkey";

-- DropForeignKey
ALTER TABLE "ClauseProgress" DROP CONSTRAINT "ClauseProgress_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Practice" DROP CONSTRAINT "Practice_applicabilityDecidedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "Practice" DROP CONSTRAINT "Practice_createdByUserId_fkey";

-- DropForeignKey
ALTER TABLE "Practice" DROP CONSTRAINT "Practice_ownerUserId_fkey";

-- DropForeignKey
ALTER TABLE "Practice" DROP CONSTRAINT "Practice_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "PracticeAsset" DROP CONSTRAINT "PracticeAsset_assetId_fkey";

-- DropForeignKey
ALTER TABLE "PracticeAsset" DROP CONSTRAINT "PracticeAsset_practiceId_fkey";

-- DropForeignKey
ALTER TABLE "PracticeAsset" DROP CONSTRAINT "PracticeAsset_createdByUserId_fkey";

-- DropForeignKey
ALTER TABLE "PracticeAsset" DROP CONSTRAINT "PracticeAsset_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "PracticeTask" DROP CONSTRAINT "PracticeTask_assigneeUserId_fkey";

-- DropForeignKey
ALTER TABLE "PracticeTask" DROP CONSTRAINT "PracticeTask_practiceId_fkey";

-- DropForeignKey
ALTER TABLE "PracticeTask" DROP CONSTRAINT "PracticeTask_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "PracticeEvidenceLink" DROP CONSTRAINT "PracticeEvidenceLink_practiceId_fkey";

-- DropForeignKey
ALTER TABLE "PracticeEvidenceLink" DROP CONSTRAINT "PracticeEvidenceLink_createdByUserId_fkey";

-- DropForeignKey
ALTER TABLE "PracticeEvidenceLink" DROP CONSTRAINT "PracticeEvidenceLink_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Policy" DROP CONSTRAINT "Policy_currentVersionId_fkey";

-- DropForeignKey
ALTER TABLE "Policy" DROP CONSTRAINT "Policy_ownerUserId_fkey";

-- DropForeignKey
ALTER TABLE "Policy" DROP CONSTRAINT "Policy_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "PolicyVersion" DROP CONSTRAINT "PolicyVersion_createdById_fkey";

-- DropForeignKey
ALTER TABLE "PolicyVersion" DROP CONSTRAINT "PolicyVersion_policyId_fkey";

-- DropForeignKey
ALTER TABLE "PolicyVersion" DROP CONSTRAINT "PolicyVersion_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "PolicyApproval" DROP CONSTRAINT "PolicyApproval_approvedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "PolicyApproval" DROP CONSTRAINT "PolicyApproval_policyId_fkey";

-- DropForeignKey
ALTER TABLE "PolicyApproval" DROP CONSTRAINT "PolicyApproval_policyVersionId_fkey";

-- DropForeignKey
ALTER TABLE "PolicyApproval" DROP CONSTRAINT "PolicyApproval_requestedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "PolicyApproval" DROP CONSTRAINT "PolicyApproval_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "PolicyAcknowledgement" DROP CONSTRAINT "PolicyAcknowledgement_policyVersionId_fkey";

-- DropForeignKey
ALTER TABLE "PolicyAcknowledgement" DROP CONSTRAINT "PolicyAcknowledgement_userId_fkey";

-- DropForeignKey
ALTER TABLE "PolicyPracticeLink" DROP CONSTRAINT "PolicyPracticeLink_practiceId_fkey";

-- DropForeignKey
ALTER TABLE "PolicyPracticeLink" DROP CONSTRAINT "PolicyPracticeLink_policyId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "PolicyPracticeLink" DROP CONSTRAINT "PolicyPracticeLink_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Finding" DROP CONSTRAINT "Finding_auditId_fkey";

-- DropForeignKey
ALTER TABLE "Finding" DROP CONSTRAINT "Finding_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Finding" DROP CONSTRAINT "Finding_assigneeUserId_fkey";

-- DropForeignKey
ALTER TABLE "Finding" DROP CONSTRAINT "Finding_practiceId_fkey";

-- DropForeignKey
ALTER TABLE "Finding" DROP CONSTRAINT "Finding_compensatingPracticeId_fkey";

-- DropForeignKey
ALTER TABLE "FindingEvidence" DROP CONSTRAINT "FindingEvidence_evidenceId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "FindingEvidence" DROP CONSTRAINT "FindingEvidence_findingId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "FindingEvidence" DROP CONSTRAINT "FindingEvidence_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "FrameworkRequirement" DROP CONSTRAINT "FrameworkRequirement_frameworkId_fkey";

-- DropForeignKey
ALTER TABLE "FrameworkRequirementOrder" DROP CONSTRAINT "FrameworkRequirementOrder_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "FrameworkRequirementOrder" DROP CONSTRAINT "FrameworkRequirementOrder_requirementId_fkey";

-- DropForeignKey
ALTER TABLE "FrameworkPack" DROP CONSTRAINT "FrameworkPack_frameworkId_fkey";

-- DropForeignKey
ALTER TABLE "FrameworkMapping" DROP CONSTRAINT "FrameworkMapping_fromRequirementId_fkey";

-- DropForeignKey
ALTER TABLE "FrameworkMapping" DROP CONSTRAINT "FrameworkMapping_toPracticeId_fkey";

-- DropForeignKey
ALTER TABLE "FrameworkMapping" DROP CONSTRAINT "FrameworkMapping_toRequirementId_fkey";

-- DropForeignKey
ALTER TABLE "RequirementMappingSet" DROP CONSTRAINT "RequirementMappingSet_sourceFrameworkId_fkey";

-- DropForeignKey
ALTER TABLE "RequirementMappingSet" DROP CONSTRAINT "RequirementMappingSet_targetFrameworkId_fkey";

-- DropForeignKey
ALTER TABLE "RequirementMapping" DROP CONSTRAINT "RequirementMapping_mappingSetId_fkey";

-- DropForeignKey
ALTER TABLE "RequirementMapping" DROP CONSTRAINT "RequirementMapping_sourceRequirementId_fkey";

-- DropForeignKey
ALTER TABLE "RequirementMapping" DROP CONSTRAINT "RequirementMapping_targetRequirementId_fkey";

-- DropForeignKey
ALTER TABLE "PracticeRequirementLink" DROP CONSTRAINT "PracticeRequirementLink_practiceId_fkey";

-- DropForeignKey
ALTER TABLE "PracticeRequirementLink" DROP CONSTRAINT "PracticeRequirementLink_requirementId_fkey";

-- DropForeignKey
ALTER TABLE "PracticeRequirementLink" DROP CONSTRAINT "PracticeRequirementLink_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "TreatmentMilestone" DROP CONSTRAINT "TreatmentMilestone_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "TreatmentMilestone" DROP CONSTRAINT "TreatmentMilestone_completedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "Evidence" DROP CONSTRAINT "Evidence_practiceId_fkey";

-- DropForeignKey
ALTER TABLE "Vendor" DROP CONSTRAINT "Vendor_ownerUserId_fkey";

-- DropForeignKey
ALTER TABLE "Vendor" DROP CONSTRAINT "Vendor_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "VendorContact" DROP CONSTRAINT "VendorContact_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "VendorContact" DROP CONSTRAINT "VendorContact_vendorId_fkey";

-- DropForeignKey
ALTER TABLE "VendorDocument" DROP CONSTRAINT "VendorDocument_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "VendorDocument" DROP CONSTRAINT "VendorDocument_uploadedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "VendorDocument" DROP CONSTRAINT "VendorDocument_vendorId_fkey";

-- DropForeignKey
ALTER TABLE "QuestionnaireQuestion" DROP CONSTRAINT "QuestionnaireQuestion_templateId_fkey";

-- DropForeignKey
ALTER TABLE "VendorAssessmentTemplate" DROP CONSTRAINT "VendorAssessmentTemplate_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "VendorAssessmentTemplate" DROP CONSTRAINT "VendorAssessmentTemplate_createdByUserId_fkey";

-- DropForeignKey
ALTER TABLE "VendorAssessmentTemplateSection" DROP CONSTRAINT "VendorAssessmentTemplateSection_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "VendorAssessmentTemplateSection" DROP CONSTRAINT "VendorAssessmentTemplateSection_templateId_fkey";

-- DropForeignKey
ALTER TABLE "VendorAssessmentTemplateQuestion" DROP CONSTRAINT "VendorAssessmentTemplateQuestion_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "VendorAssessmentTemplateQuestion" DROP CONSTRAINT "VendorAssessmentTemplateQuestion_templateId_fkey";

-- DropForeignKey
ALTER TABLE "VendorAssessmentTemplateQuestion" DROP CONSTRAINT "VendorAssessmentTemplateQuestion_sectionId_fkey";

-- DropForeignKey
ALTER TABLE "VendorAssessment" DROP CONSTRAINT "VendorAssessment_decidedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "VendorAssessment" DROP CONSTRAINT "VendorAssessment_requestedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "VendorAssessment" DROP CONSTRAINT "VendorAssessment_sentByUserId_fkey";

-- DropForeignKey
ALTER TABLE "VendorAssessment" DROP CONSTRAINT "VendorAssessment_reviewedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "VendorAssessment" DROP CONSTRAINT "VendorAssessment_closedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "VendorAssessment" DROP CONSTRAINT "VendorAssessment_templateId_fkey";

-- DropForeignKey
ALTER TABLE "VendorAssessment" DROP CONSTRAINT "VendorAssessment_templateVersionId_fkey";

-- DropForeignKey
ALTER TABLE "VendorAssessment" DROP CONSTRAINT "VendorAssessment_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "VendorAssessment" DROP CONSTRAINT "VendorAssessment_vendorId_fkey";

-- DropForeignKey
ALTER TABLE "VendorAssessmentAnswer" DROP CONSTRAINT "VendorAssessmentAnswer_assessmentId_fkey";

-- DropForeignKey
ALTER TABLE "VendorAssessmentAnswer" DROP CONSTRAINT "VendorAssessmentAnswer_questionId_fkey";

-- DropForeignKey
ALTER TABLE "VendorAssessmentAnswer" DROP CONSTRAINT "VendorAssessmentAnswer_templateQuestionId_fkey";

-- DropForeignKey
ALTER TABLE "VendorAssessmentAnswer" DROP CONSTRAINT "VendorAssessmentAnswer_evidenceId_fkey";

-- DropForeignKey
ALTER TABLE "VendorAssessmentAnswer" DROP CONSTRAINT "VendorAssessmentAnswer_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "VendorLink" DROP CONSTRAINT "VendorLink_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "VendorLink" DROP CONSTRAINT "VendorLink_vendorId_fkey";

-- DropForeignKey
ALTER TABLE "VendorEvidenceBundle" DROP CONSTRAINT "VendorEvidenceBundle_createdByUserId_fkey";

-- DropForeignKey
ALTER TABLE "VendorEvidenceBundle" DROP CONSTRAINT "VendorEvidenceBundle_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "VendorEvidenceBundle" DROP CONSTRAINT "VendorEvidenceBundle_vendorId_fkey";

-- DropForeignKey
ALTER TABLE "VendorEvidenceBundleItem" DROP CONSTRAINT "VendorEvidenceBundleItem_bundleId_fkey";

-- DropForeignKey
ALTER TABLE "VendorEvidenceBundleItem" DROP CONSTRAINT "VendorEvidenceBundleItem_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "VendorRelationship" DROP CONSTRAINT "VendorRelationship_primaryVendorId_fkey";

-- DropForeignKey
ALTER TABLE "VendorRelationship" DROP CONSTRAINT "VendorRelationship_subprocessorVendorId_fkey";

-- DropForeignKey
ALTER TABLE "VendorRelationship" DROP CONSTRAINT "VendorRelationship_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Task" DROP CONSTRAINT "Task_practiceId_fkey";

-- DropIndex
DROP INDEX "AssetMaintenance_tenantId_vendorId_idx";

-- DropIndex
DROP INDEX "IntegrationExecution_tenantId_practiceId_idx";

-- DropIndex
DROP INDEX "ProcessEdgePractice_tenantId_practiceId_idx";

-- DropIndex
DROP INDEX "Evidence_tenantId_practiceId_idx";

-- DropIndex
DROP INDEX "Evidence_tenantId_sourceLogEntryId_practiceId_key";

-- DropIndex
DROP INDEX "Task_tenantId_practiceId_idx";

-- DropIndex
DROP INDEX "Task_tenantId_practiceId_status_idx";

-- AlterTable
ALTER TABLE "AssetMaintenance" DROP COLUMN "vendorId";

-- AlterTable
ALTER TABLE "ComplianceSnapshot" DROP COLUMN "findingsOpen",
DROP COLUMN "policiesOverdueReview",
DROP COLUMN "policiesPublished",
DROP COLUMN "policiesTotal",
DROP COLUMN "practiceCoverageBps",
DROP COLUMN "practicesApplicable",
DROP COLUMN "practicesImplemented",
DROP COLUMN "practicesInProgress",
DROP COLUMN "practicesNotStarted",
DROP COLUMN "practicesTotal",
DROP COLUMN "vendorsOverdueReview",
DROP COLUMN "vendorsTotal";

-- AlterTable
ALTER TABLE "IntegrationExecution" DROP COLUMN "practiceId";

-- AlterTable
ALTER TABLE "ProcessEdgePractice" DROP COLUMN "practiceId";

-- AlterTable
ALTER TABLE "Evidence" DROP COLUMN "practiceId";

-- AlterTable
ALTER TABLE "Task" DROP COLUMN "practiceId";

-- DropTable
DROP TABLE "Audit";

-- DropTable
DROP TABLE "AuditChecklistItem";

-- DropTable
DROP TABLE "AuditCycle";

-- DropTable
DROP TABLE "AuditPack";

-- DropTable
DROP TABLE "AuditPackItem";

-- DropTable
DROP TABLE "AuditPackShare";

-- DropTable
DROP TABLE "AuditorAccount";

-- DropTable
DROP TABLE "AuditorPackAccess";

-- DropTable
DROP TABLE "ReadinessSnapshot";

-- DropTable
DROP TABLE "Clause";

-- DropTable
DROP TABLE "ClauseProgress";

-- DropTable
DROP TABLE "PracticeKeySequence";

-- DropTable
DROP TABLE "Practice";

-- DropTable
DROP TABLE "PracticeAsset";

-- DropTable
DROP TABLE "PracticeTask";

-- DropTable
DROP TABLE "PracticeEvidenceLink";

-- DropTable
DROP TABLE "Policy";

-- DropTable
DROP TABLE "PolicyVersion";

-- DropTable
DROP TABLE "PolicyApproval";

-- DropTable
DROP TABLE "PolicyAcknowledgement";

-- DropTable
DROP TABLE "PolicyPracticeLink";

-- DropTable
DROP TABLE "PolicyTemplate";

-- DropTable
DROP TABLE "Finding";

-- DropTable
DROP TABLE "FindingEvidence";

-- DropTable
DROP TABLE "Framework";

-- DropTable
DROP TABLE "FrameworkRequirement";

-- DropTable
DROP TABLE "FrameworkRequirementOrder";

-- DropTable
DROP TABLE "FrameworkPack";

-- DropTable
DROP TABLE "FrameworkMapping";

-- DropTable
DROP TABLE "RequirementMappingSet";

-- DropTable
DROP TABLE "RequirementMapping";

-- DropTable
DROP TABLE "PracticeRequirementLink";

-- DropTable
DROP TABLE "TreatmentMilestone";

-- DropTable
DROP TABLE "Vendor";

-- DropTable
DROP TABLE "VendorContact";

-- DropTable
DROP TABLE "VendorDocument";

-- DropTable
DROP TABLE "QuestionnaireTemplate";

-- DropTable
DROP TABLE "QuestionnaireQuestion";

-- DropTable
DROP TABLE "VendorAssessmentTemplate";

-- DropTable
DROP TABLE "VendorAssessmentTemplateSection";

-- DropTable
DROP TABLE "VendorAssessmentTemplateQuestion";

-- DropTable
DROP TABLE "VendorAssessment";

-- DropTable
DROP TABLE "VendorAssessmentAnswer";

-- DropTable
DROP TABLE "VendorLink";

-- DropTable
DROP TABLE "VendorEvidenceBundle";

-- DropTable
DROP TABLE "VendorEvidenceBundleItem";

-- DropTable
DROP TABLE "VendorRelationship";

-- DropEnum
DROP TYPE "ClauseStatus";

-- DropEnum
DROP TYPE "CoverageType";

-- DropEnum
DROP TYPE "ExposureLevel";

-- DropEnum
DROP TYPE "TreatmentDecision";

-- DropEnum
DROP TYPE "FairConfidence";

-- DropEnum
DROP TYPE "PracticeStatus";

-- DropEnum
DROP TYPE "PracticeMitigationType";

-- DropEnum
DROP TYPE "Applicability";

-- DropEnum
DROP TYPE "PracticeFrequency";

-- DropEnum
DROP TYPE "AutomationType";

-- DropEnum
DROP TYPE "EvidenceSourceType";

-- DropEnum
DROP TYPE "EvidenceLinkKind";

-- DropEnum
DROP TYPE "PracticeTaskStatus";

-- DropEnum
DROP TYPE "PolicyStatus";

-- DropEnum
DROP TYPE "PolicyContentType";

-- DropEnum
DROP TYPE "PolicyApprovalStatus";

-- DropEnum
DROP TYPE "ApprovalDecision";

-- DropEnum
DROP TYPE "AuditStatus";

-- DropEnum
DROP TYPE "ChecklistResult";

-- DropEnum
DROP TYPE "RiskStatus";

-- DropEnum
DROP TYPE "FindingSeverity";

-- DropEnum
DROP TYPE "FindingType";

-- DropEnum
DROP TYPE "FindingStatus";

-- DropEnum
DROP TYPE "SuggestionSessionStatus";

-- DropEnum
DROP TYPE "SuggestionItemStatus";

-- DropEnum
DROP TYPE "FrameworkKind";

-- DropEnum
DROP TYPE "MappingStrength";

-- DropEnum
DROP TYPE "VendorStatus";

-- DropEnum
DROP TYPE "VendorCriticality";

-- DropEnum
DROP TYPE "VendorDataAccess";

-- DropEnum
DROP TYPE "VendorDocumentType";

-- DropEnum
DROP TYPE "AnswerType";

-- DropEnum
DROP TYPE "AssessmentStatus";

-- DropEnum
DROP TYPE "VendorLinkEntityType";

-- DropEnum
DROP TYPE "VendorLinkRelation";

-- DropEnum
DROP TYPE "AuditCycleStatus";

-- DropEnum
DROP TYPE "AuditPackStatus";

-- DropEnum
DROP TYPE "AuditorStatus";

-- DropEnum
DROP TYPE "AuditPackItemEntityType";

-- DropEnum
DROP TYPE "TreatmentStrategy";

-- DropEnum
DROP TYPE "TreatmentPlanStatus";

-- DropEnum
DROP TYPE "RiskScoreEventKind";

-- DropEnum
DROP TYPE "RiskScoreEventSource";

-- DropEnum
DROP TYPE "LossEventSource";

-- CreateIndex
CREATE UNIQUE INDEX "Evidence_tenantId_sourceLogEntryId_key" ON "Evidence"("tenantId", "sourceLogEntryId");

