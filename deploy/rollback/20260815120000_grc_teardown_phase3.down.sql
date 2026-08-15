-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK — undo `20260815120000_grc_teardown_phase3`
-- ═══════════════════════════════════════════════════════════════════════
--
-- WHY THIS FILE EXISTS
--
-- Pinning Watchtower to the previous image does NOT undo a migration.
-- The previous image's Prisma client still SELECTs five columns this
-- migration dropped — `Evidence.practiceId`, `Task.practiceId`,
-- `IntegrationExecution.practiceId`, `ProcessEdgePractice.practiceId`,
-- `AssetMaintenance.vendorId` — and those are columns on LIVE tables
-- that the agri product reads constantly. So an image-only rollback
-- does not degrade to "the GRC pages are broken"; it breaks the
-- evidence library and the task list. Without this script the only
-- remaining lever is a snapshot restore: daily at 02:00 UTC, so up to
-- 24 hours of farm data thrown away (docs/backup-restore.md).
--
-- Prisma has no down-migrations, so this is deliberately NOT a
-- migration directory. It is a psql script an operator runs by hand.
--
-- ── WHAT THIS RESTORES, AND WHAT IT DOES NOT ─────────────────────────
--
-- RESTORES: the SHAPE the previous image expects — 47 tables, 44 enums,
-- 148 indexes, 119 foreign keys, the 5 columns above, and the values
-- narrowed out of WorkItemType / TaskLinkEntityType / NotificationType /
-- ModuleKey. Generated mechanically by `prisma migrate diff` in the
-- reverse direction, so it is an exact inverse of the DDL rather than a
-- hand-transcription of it.
--
-- DOES NOT RESTORE, and both are deliberate:
--
--   1. ROW DATA. Dropped tables cannot be un-dropped with their
--      contents. This is acceptable only because all 47 held ZERO rows
--      in production when phase 3 shipped (measured 2026-08-15, see the
--      forward migration's header). If you are reading this on a
--      database where that was not true, this script is NOT a
--      sufficient rollback and you want the snapshot.
--
--   2. ROW-LEVEL SECURITY on the recreated GRC tables. The forward
--      migration dropped the tables and their policies together; this
--      script recreates the tables bare. `FORCE ROW LEVEL SECURITY`
--      and the `tenant_isolation` / `superuser_bypass` pair do NOT come
--      back, so `tests/guardrails/rls-coverage.test.ts` will fail
--      against a rolled-back database. That is the correct signal, not
--      a bug in this script: the tables are empty and the previous
--      image (phase 2) contains no code that reads them, so there is
--      nothing to isolate — but a database in this state must not be
--      left there, and a red RLS guard is what stops it being
--      forgotten. Roll forward again once the reason for the rollback
--      is resolved.
--
-- ── ORDERING AGAINST THE OTHER ROLLBACK SCRIPT ───────────────────────
--
-- `20260809120000_rename_control_to_practice.down.sql` renames
-- `NotificationType.PRACTICE_ASSIGNED` back to `CONTROL_ASSIGNED`. That
-- value no longer exists after phase 3, so running the two out of order
-- fails. If you need to get back behind the Control→Practice rename,
-- run THIS script first (it re-adds PRACTICE_ASSIGNED) and the rename
-- inverse second.
--
-- ── HOW TO RUN ────────────────────────────────────────────────────────
--
--   1. Stop the app + worker first. Running this under a live app means
--      in-flight queries hit tables mid-change.
--        gcloud compute ssh agrent --zone europe-west1-b \
--          --command "cd /opt/agrent && sudo docker compose \
--            -f docker-compose.vm.yml stop app worker"
--
--   2. Apply, against the DIRECT database URL (not PgBouncer — this is
--      DDL in one transaction):
--        psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 \
--          -f deploy/rollback/20260815120000_grc_teardown_phase3.down.sql
--
--   3. Start the PREVIOUS image. If you start the new one, its
--      entrypoint re-applies the forward migration and you are back
--      where you started.
--
-- The whole script is one transaction: Postgres DDL is transactional, so
-- a failure anywhere leaves the database exactly as it was. The
-- `ALTER TYPE … ADD VALUE` statements are transaction-safe on the
-- Postgres 16 the VM runs (PG 12+ lifted that restriction), and no
-- recreated table defaults to one of the re-added values, so nothing
-- needs a value it cannot yet use.
--
-- ── THE `_prisma_migrations` ROW ──────────────────────────────────────
--
-- The last statement deletes the migration's bookkeeping row, and it is
-- load-bearing rather than tidy-up. `prisma migrate deploy` decides what
-- to run by consulting that table. Leave the row in place and a later
-- roll-forward SKIPS phase 3 as already-applied — new code, old schema,
-- the same outage in the opposite direction. Deleting it means
-- redeploying the new image simply re-applies phase 3 and recovers.
--
-- So this script is reversible: down → up → down all work.

BEGIN;


-- CreateEnum
CREATE TYPE "ClauseStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'READY', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "CoverageType" AS ENUM ('FULL', 'PARTIAL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ExposureLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "TreatmentDecision" AS ENUM ('TREAT', 'TRANSFER', 'TOLERATE', 'AVOID');

-- CreateEnum
CREATE TYPE "FairConfidence" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "PracticeStatus" AS ENUM ('NOT_STARTED', 'PLANNED', 'IN_PROGRESS', 'IMPLEMENTING', 'IMPLEMENTED', 'NEEDS_REVIEW', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "PracticeMitigationType" AS ENUM ('PREVENTIVE', 'DETERRENT', 'DETECTIVE', 'CORRECTIVE', 'COMPENSATING');

-- CreateEnum
CREATE TYPE "Applicability" AS ENUM ('APPLICABLE', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "PracticeFrequency" AS ENUM ('AD_HOC', 'DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY');

-- CreateEnum
CREATE TYPE "AutomationType" AS ENUM ('MANUAL', 'SCRIPT', 'INTEGRATION');

-- CreateEnum
CREATE TYPE "EvidenceSourceType" AS ENUM ('MANUAL', 'INTEGRATION');

-- CreateEnum
CREATE TYPE "EvidenceLinkKind" AS ENUM ('FILE', 'LINK', 'INTEGRATION_RESULT');

-- CreateEnum
CREATE TYPE "PracticeTaskStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "PolicyStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PolicyContentType" AS ENUM ('MARKDOWN', 'HTML', 'EXTERNAL_LINK');

-- CreateEnum
CREATE TYPE "PolicyApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AuditStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ChecklistResult" AS ENUM ('NOT_TESTED', 'PASS', 'FAIL');

-- CreateEnum
CREATE TYPE "RiskStatus" AS ENUM ('OPEN', 'MITIGATING', 'MITIGATED', 'ACCEPTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "FindingSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "FindingType" AS ENUM ('NONCONFORMITY', 'OBSERVATION', 'OPPORTUNITY');

-- CreateEnum
CREATE TYPE "FindingStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'READY_FOR_VERIFICATION', 'CLOSED');

-- CreateEnum
CREATE TYPE "SuggestionSessionStatus" AS ENUM ('DRAFT', 'GENERATED', 'APPLIED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "SuggestionItemStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EDITED');

-- CreateEnum
CREATE TYPE "FrameworkKind" AS ENUM ('ISO_STANDARD', 'NIST_FRAMEWORK', 'SOC_CRITERIA', 'EU_DIRECTIVE', 'REGULATION', 'INDUSTRY_STANDARD', 'CUSTOM', 'AG_SCHEME');

-- CreateEnum
CREATE TYPE "MappingStrength" AS ENUM ('EQUAL', 'SUPERSET', 'SUBSET', 'INTERSECT', 'RELATED');

-- CreateEnum
CREATE TYPE "VendorStatus" AS ENUM ('ACTIVE', 'ONBOARDING', 'OFFBOARDING', 'OFFBOARDED');

-- CreateEnum
CREATE TYPE "VendorCriticality" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "VendorDataAccess" AS ENUM ('NONE', 'LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "VendorDocumentType" AS ENUM ('CONTRACT', 'SOC2', 'ISO_CERT', 'DPA', 'SECURITY_POLICY', 'PEN_TEST', 'OTHER');

-- CreateEnum
CREATE TYPE "AnswerType" AS ENUM ('YES_NO', 'SINGLE_SELECT', 'MULTI_SELECT', 'TEXT', 'NUMBER', 'SCALE', 'FILE_UPLOAD');

-- CreateEnum
CREATE TYPE "AssessmentStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'SENT', 'IN_PROGRESS', 'SUBMITTED', 'REVIEWED', 'CLOSED');

-- CreateEnum
CREATE TYPE "VendorLinkEntityType" AS ENUM ('ASSET', 'ISSUE', 'PRACTICE');

-- CreateEnum
CREATE TYPE "VendorLinkRelation" AS ENUM ('USES', 'STORES_DATA_FOR', 'PROVIDES_SERVICE_TO', 'MITIGATES', 'RELATED');

-- CreateEnum
CREATE TYPE "AuditCycleStatus" AS ENUM ('PLANNING', 'IN_PROGRESS', 'READY', 'COMPLETE');

-- CreateEnum
CREATE TYPE "AuditPackStatus" AS ENUM ('DRAFT', 'FROZEN', 'EXPORTED');

-- CreateEnum
CREATE TYPE "AuditorStatus" AS ENUM ('INVITED', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "AuditPackItemEntityType" AS ENUM ('PRACTICE', 'POLICY', 'EVIDENCE', 'FILE', 'ISSUE', 'READINESS_REPORT', 'FRAMEWORK_COVERAGE', 'TEST_RUN', 'EXPORT_ARTIFACT');

-- CreateEnum
CREATE TYPE "TreatmentStrategy" AS ENUM ('MITIGATE', 'ACCEPT', 'TRANSFER', 'AVOID');

-- CreateEnum
CREATE TYPE "TreatmentPlanStatus" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED', 'OVERDUE');

-- CreateEnum
CREATE TYPE "RiskScoreEventKind" AS ENUM ('INHERENT', 'RESIDUAL');

-- CreateEnum
CREATE TYPE "RiskScoreEventSource" AS ENUM ('USER', 'DERIVED', 'PLAN', 'AI', 'MIGRATION');

-- CreateEnum
CREATE TYPE "LossEventSource" AS ENUM ('USER', 'FINDING', 'INCIDENT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WorkItemType" ADD VALUE 'AUDIT_FINDING';
ALTER TYPE "WorkItemType" ADD VALUE 'PRACTICE_GAP';
ALTER TYPE "WorkItemType" ADD VALUE 'INCIDENT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TaskLinkEntityType" ADD VALUE 'PRACTICE';
ALTER TYPE "TaskLinkEntityType" ADD VALUE 'FRAMEWORK_REQUIREMENT';
ALTER TYPE "TaskLinkEntityType" ADD VALUE 'POLICY';
ALTER TYPE "TaskLinkEntityType" ADD VALUE 'AUDIT_PACK';
ALTER TYPE "TaskLinkEntityType" ADD VALUE 'VENDOR';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'POLICY_APPROVAL_NEEDED';
ALTER TYPE "NotificationType" ADD VALUE 'POLICY_ACKNOWLEDGED';
ALTER TYPE "NotificationType" ADD VALUE 'FINDING_ASSIGNED';
ALTER TYPE "NotificationType" ADD VALUE 'FINDING_VERIFIED';
ALTER TYPE "NotificationType" ADD VALUE 'PRACTICE_ASSIGNED';
ALTER TYPE "NotificationType" ADD VALUE 'RISK_ASSIGNED';
ALTER TYPE "NotificationType" ADD VALUE 'VENDOR_REVIEW_DUE';

-- AlterEnum
ALTER TYPE "ModuleKey" ADD VALUE 'VENDORS';

-- DropIndex
DROP INDEX "Evidence_tenantId_sourceLogEntryId_key";

-- AlterTable
ALTER TABLE "AssetMaintenance" ADD COLUMN     "vendorId" TEXT;

-- AlterTable
ALTER TABLE "ComplianceSnapshot" ADD COLUMN     "findingsOpen" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "policiesOverdueReview" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "policiesPublished" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "policiesTotal" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "practiceCoverageBps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "practicesApplicable" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "practicesImplemented" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "practicesInProgress" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "practicesNotStarted" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "practicesTotal" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "vendorsOverdueReview" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "vendorsTotal" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "IntegrationExecution" ADD COLUMN     "practiceId" TEXT;

-- AlterTable
ALTER TABLE "ProcessEdgePractice" ADD COLUMN     "practiceId" TEXT;

-- AlterTable
ALTER TABLE "Evidence" ADD COLUMN     "practiceId" TEXT;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "practiceId" TEXT;

-- CreateTable
CREATE TABLE "Audit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "frameworkKey" TEXT,
    "auditScope" TEXT,
    "criteria" TEXT,
    "schedule" TIMESTAMP(3),
    "auditors" TEXT,
    "auditees" TEXT,
    "departments" TEXT,
    "status" "AuditStatus" NOT NULL DEFAULT 'PLANNED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" TEXT,

    CONSTRAINT "Audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditChecklistItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "auditId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "result" "ChecklistResult" NOT NULL DEFAULT 'NOT_TESTED',
    "notes" TEXT,
    "evidenceRef" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AuditChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditCycle" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "frameworkKey" TEXT NOT NULL,
    "frameworkVersion" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "periodStartAt" TIMESTAMP(3),
    "periodEndAt" TIMESTAMP(3),
    "status" "AuditCycleStatus" NOT NULL DEFAULT 'PLANNING',
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" TEXT,

    CONSTRAINT "AuditCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditPack" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "auditCycleId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "AuditPackStatus" NOT NULL DEFAULT 'DRAFT',
    "frozenAt" TIMESTAMP(3),
    "frozenByUserId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" TEXT,
    "spExportItemId" TEXT,
    "spExportWebUrl" TEXT,
    "spExportedAt" TIMESTAMP(3),

    CONSTRAINT "AuditPack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditPackItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "auditPackId" TEXT NOT NULL,
    "entityType" "AuditPackItemEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "snapshotJson" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditPackItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditPackShare" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "auditPackId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditPackShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditorAccount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "emailEncrypted" TEXT NOT NULL,
    "emailHash" TEXT,
    "nameEncrypted" TEXT,
    "status" "AuditorStatus" NOT NULL DEFAULT 'INVITED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditorAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditorPackAccess" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "auditorId" TEXT NOT NULL,
    "auditPackId" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditorPackAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReadinessSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "frameworkKey" TEXT NOT NULL,
    "auditCycleId" TEXT,
    "score" INTEGER NOT NULL,
    "breakdownJson" JSONB NOT NULL,
    "gapCount" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "computedByUserId" TEXT,

    CONSTRAINT "ReadinessSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Clause" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "artifacts" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Clause_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClauseProgress" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clauseId" TEXT NOT NULL,
    "status" "ClauseStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClauseProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeKeySequence" (
    "tenantId" TEXT NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PracticeKeySequence_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "Practice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "intent" TEXT,
    "category" TEXT,
    "status" "PracticeStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "effectiveness" INTEGER,
    "reviewCadence" "ReviewCadence",
    "isCustom" BOOLEAN NOT NULL DEFAULT false,
    "ownerUserId" TEXT,
    "createdByUserId" TEXT,
    "frequency" "PracticeFrequency",
    "nextDueAt" TIMESTAMP(3),
    "evidenceSource" "EvidenceSourceType",
    "automationKey" TEXT,
    "mitigationType" "PracticeMitigationType",
    "applicability" "Applicability" NOT NULL DEFAULT 'APPLICABLE',
    "applicabilityJustification" TEXT,
    "applicabilityDecidedByUserId" TEXT,
    "applicabilityDecidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" TEXT,
    "retentionUntil" TIMESTAMP(3),

    CONSTRAINT "Practice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeAsset" (
    "id" TEXT NOT NULL,
    "practiceId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "coverageType" "CoverageType" NOT NULL DEFAULT 'UNKNOWN',
    "rationale" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PracticeAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeTask" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "practiceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "PracticeTaskStatus" NOT NULL DEFAULT 'OPEN',
    "assigneeUserId" TEXT,
    "dueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PracticeTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeEvidenceLink" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "practiceId" TEXT NOT NULL,
    "kind" "EvidenceLinkKind" NOT NULL,
    "fileId" TEXT,
    "url" TEXT,
    "integrationResultId" TEXT,
    "note" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PracticeEvidenceLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Policy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "status" "PolicyStatus" NOT NULL DEFAULT 'DRAFT',
    "currentVersionId" TEXT,
    "ownerUserId" TEXT,
    "reviewFrequencyDays" INTEGER,
    "nextReviewAt" TIMESTAMP(3),
    "language" TEXT DEFAULT 'en',
    "lifecycleVersion" INTEGER NOT NULL DEFAULT 1,
    "lifecycleHistoryJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" TEXT,
    "retentionUntil" TIMESTAMP(3),
    "spDriveId" TEXT,
    "spItemId" TEXT,
    "spItemETag" TEXT,
    "spWebUrl" TEXT,
    "spSubscriptionId" TEXT,
    "spConnectionId" TEXT,

    CONSTRAINT "Policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyVersion" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "contentType" "PolicyContentType" NOT NULL DEFAULT 'MARKDOWN',
    "contentText" TEXT,
    "externalUrl" TEXT,
    "changeSummary" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "PolicyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyApproval" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "policyVersionId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "approvedByUserId" TEXT,
    "status" "PolicyApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "decidedAt" TIMESTAMP(3),
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyAcknowledgement" (
    "id" TEXT NOT NULL,
    "policyVersionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyAcknowledgement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyPracticeLink" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "practiceId" TEXT NOT NULL,

    CONSTRAINT "PolicyPracticeLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyTemplate" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT,
    "language" TEXT DEFAULT 'en',
    "contentType" "PolicyContentType" NOT NULL DEFAULT 'MARKDOWN',
    "contentText" TEXT NOT NULL,
    "tags" TEXT,
    "isGlobal" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolicyTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Finding" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "auditId" TEXT,
    "severity" "FindingSeverity" NOT NULL,
    "type" "FindingType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "rootCause" TEXT,
    "correctiveAction" TEXT,
    "analysis" TEXT,
    "owner" TEXT,
    "assigneeUserId" TEXT,
    "practiceId" TEXT,
    "compensatingPracticeId" TEXT,
    "dueDate" TIMESTAMP(3),
    "status" "FindingStatus" NOT NULL DEFAULT 'OPEN',
    "verificationNotes" TEXT,
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" TEXT,

    CONSTRAINT "Finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FindingEvidence" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,

    CONSTRAINT "FindingEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Framework" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "name" TEXT NOT NULL,
    "version" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "coverageNote" TEXT,
    "metadataJson" TEXT,
    "contentHash" TEXT,
    "sourceUrn" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" "FrameworkKind" NOT NULL DEFAULT 'ISO_STANDARD',

    CONSTRAINT "Framework_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FrameworkRequirement" (
    "id" TEXT NOT NULL,
    "frameworkId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "theme" TEXT,
    "themeNumber" INTEGER,
    "section" TEXT,
    "deprecatedAt" TIMESTAMP(3),

    CONSTRAINT "FrameworkRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FrameworkRequirementOrder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FrameworkRequirementOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FrameworkPack" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "frameworkId" TEXT NOT NULL,
    "version" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FrameworkPack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FrameworkMapping" (
    "id" TEXT NOT NULL,
    "fromRequirementId" TEXT NOT NULL,
    "toRequirementId" TEXT,
    "toPracticeId" TEXT,
    "rationale" TEXT,

    CONSTRAINT "FrameworkMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequirementMappingSet" (
    "id" TEXT NOT NULL,
    "sourceFrameworkId" TEXT NOT NULL,
    "targetFrameworkId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "sourceUrn" TEXT,
    "contentHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequirementMappingSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequirementMapping" (
    "id" TEXT NOT NULL,
    "mappingSetId" TEXT NOT NULL,
    "sourceRequirementId" TEXT NOT NULL,
    "targetRequirementId" TEXT NOT NULL,
    "strength" "MappingStrength" NOT NULL DEFAULT 'RELATED',
    "rationale" TEXT,
    "metadataJson" TEXT,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequirementMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeRequirementLink" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "practiceId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PracticeRequirementLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TreatmentMilestone" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "treatmentPlanId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "completedByUserId" TEXT,
    "evidence" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TreatmentMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "websiteUrl" TEXT,
    "domain" TEXT,
    "country" TEXT,
    "description" TEXT,
    "ownerUserId" TEXT,
    "status" "VendorStatus" NOT NULL DEFAULT 'ONBOARDING',
    "criticality" "VendorCriticality" NOT NULL DEFAULT 'MEDIUM',
    "inherentRisk" "VendorCriticality",
    "residualRisk" "VendorCriticality",
    "nextReviewAt" TIMESTAMP(3),
    "contractRenewalAt" TIMESTAMP(3),
    "dataAccess" "VendorDataAccess",
    "isSubprocessor" BOOLEAN NOT NULL DEFAULT false,
    "tags" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "certificationsJson" JSONB,
    "enrichmentLastRunAt" TIMESTAMP(3),
    "enrichmentStatus" TEXT,
    "privacyPolicyUrl" TEXT,
    "securityPageUrl" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" TEXT,
    "retentionUntil" TIMESTAMP(3),

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorContact" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "title" TEXT,
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "nameEncrypted" TEXT,
    "emailEncrypted" TEXT,
    "emailHash" TEXT,
    "phoneEncrypted" TEXT,

    CONSTRAINT "VendorContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorDocument" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "type" "VendorDocumentType" NOT NULL,
    "fileId" TEXT,
    "externalUrl" TEXT,
    "title" TEXT,
    "folder" TEXT,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "notes" TEXT,
    "uploadedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionnaireTemplate" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isGlobal" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestionnaireTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionnaireQuestion" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "answerType" "AnswerType" NOT NULL,
    "optionsJson" JSONB,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "riskPointsJson" JSONB,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "QuestionnaireQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorAssessmentTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isLatestVersion" BOOLEAN NOT NULL DEFAULT true,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "isGlobal" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scoringConfigJson" JSONB,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorAssessmentTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorAssessmentTemplateSection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "weight" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorAssessmentTemplateSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorAssessmentTemplateQuestion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "prompt" TEXT NOT NULL,
    "answerType" "AnswerType" NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "optionsJson" JSONB,
    "scaleConfigJson" JSONB,
    "riskPointsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorAssessmentTemplateQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorAssessment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "templateId" TEXT,
    "templateVersionId" TEXT,
    "status" "AssessmentStatus" NOT NULL DEFAULT 'DRAFT',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "requestedByUserId" TEXT NOT NULL,
    "decidedByUserId" TEXT,
    "score" DOUBLE PRECISION,
    "riskRating" "VendorCriticality",
    "notes" TEXT,
    "nextReviewAt" TIMESTAMP(3),
    "lifecycleVersion" INTEGER NOT NULL DEFAULT 1,
    "lifecycleHistoryJson" JSONB,
    "sentAt" TIMESTAMP(3),
    "sentByUserId" TEXT,
    "respondentEmail" TEXT,
    "externalAccessTokenHash" TEXT,
    "externalAccessTokenExpiresAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedByUserId" TEXT,
    "reviewerNotes" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorAssessmentAnswer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "templateQuestionId" TEXT,
    "answerJson" JSONB NOT NULL,
    "computedPoints" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reviewerOverridePoints" DOUBLE PRECISION,
    "reviewerNotes" TEXT,
    "evidenceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorAssessmentAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorLink" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "entityType" "VendorLinkEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "relation" "VendorLinkRelation" NOT NULL DEFAULT 'RELATED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorEvidenceBundle" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "frozenAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorEvidenceBundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorEvidenceBundleItem" (
    "id" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "snapshotJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorEvidenceBundleItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorRelationship" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "primaryVendorId" TEXT NOT NULL,
    "subprocessorVendorId" TEXT NOT NULL,
    "purpose" TEXT,
    "dataTypes" TEXT,
    "country" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorRelationship_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Audit_tenantId_idx" ON "Audit"("tenantId");

-- CreateIndex
CREATE INDEX "Audit_tenantId_createdAt_idx" ON "Audit"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "Audit_tenantId_frameworkKey_idx" ON "Audit"("tenantId", "frameworkKey");

-- CreateIndex
CREATE INDEX "Audit_tenantId_deletedAt_idx" ON "Audit"("tenantId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Audit_id_tenantId_key" ON "Audit"("id", "tenantId");

-- CreateIndex
CREATE INDEX "AuditChecklistItem_tenantId_idx" ON "AuditChecklistItem"("tenantId");

-- CreateIndex
CREATE INDEX "AuditChecklistItem_tenantId_auditId_idx" ON "AuditChecklistItem"("tenantId", "auditId");

-- CreateIndex
CREATE INDEX "AuditCycle_tenantId_frameworkKey_status_idx" ON "AuditCycle"("tenantId", "frameworkKey", "status");

-- CreateIndex
CREATE INDEX "AuditCycle_tenantId_deletedAt_idx" ON "AuditCycle"("tenantId", "deletedAt");

-- CreateIndex
CREATE INDEX "AuditCycle_tenantId_periodStartAt_idx" ON "AuditCycle"("tenantId", "periodStartAt");

-- CreateIndex
CREATE INDEX "AuditCycle_tenantId_periodEndAt_idx" ON "AuditCycle"("tenantId", "periodEndAt");

-- CreateIndex
CREATE INDEX "AuditPack_tenantId_auditCycleId_idx" ON "AuditPack"("tenantId", "auditCycleId");

-- CreateIndex
CREATE INDEX "AuditPack_tenantId_deletedAt_idx" ON "AuditPack"("tenantId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuditPack_id_tenantId_key" ON "AuditPack"("id", "tenantId");

-- CreateIndex
CREATE INDEX "AuditPackItem_tenantId_auditPackId_idx" ON "AuditPackItem"("tenantId", "auditPackId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditPackItem_auditPackId_entityType_entityId_key" ON "AuditPackItem"("auditPackId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditPackShare_tokenHash_idx" ON "AuditPackShare"("tokenHash");

-- CreateIndex
CREATE INDEX "AuditPackShare_tenantId_auditPackId_idx" ON "AuditPackShare"("tenantId", "auditPackId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditorAccount_id_tenantId_key" ON "AuditorAccount"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditorAccount_tenantId_emailHash_key" ON "AuditorAccount"("tenantId", "emailHash");

-- CreateIndex
CREATE INDEX "AuditorPackAccess_tenantId_idx" ON "AuditorPackAccess"("tenantId");

-- CreateIndex
CREATE INDEX "AuditorPackAccess_tenantId_auditPackId_idx" ON "AuditorPackAccess"("tenantId", "auditPackId");

-- CreateIndex
CREATE INDEX "AuditorPackAccess_tenantId_auditorId_idx" ON "AuditorPackAccess"("tenantId", "auditorId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditorPackAccess_auditorId_auditPackId_key" ON "AuditorPackAccess"("auditorId", "auditPackId");

-- CreateIndex
CREATE INDEX "ReadinessSnapshot_tenantId_idx" ON "ReadinessSnapshot"("tenantId");

-- CreateIndex
CREATE INDEX "ReadinessSnapshot_tenantId_frameworkKey_computedAt_idx" ON "ReadinessSnapshot"("tenantId", "frameworkKey", "computedAt");

-- CreateIndex
CREATE INDEX "ReadinessSnapshot_tenantId_auditCycleId_idx" ON "ReadinessSnapshot"("tenantId", "auditCycleId");

-- CreateIndex
CREATE UNIQUE INDEX "Clause_number_key" ON "Clause"("number");

-- CreateIndex
CREATE UNIQUE INDEX "ClauseProgress_tenantId_clauseId_key" ON "ClauseProgress"("tenantId", "clauseId");

-- CreateIndex
CREATE INDEX "Practice_tenantId_code_idx" ON "Practice"("tenantId", "code");

-- CreateIndex
CREATE INDEX "Practice_tenantId_idx" ON "Practice"("tenantId");

-- CreateIndex
CREATE INDEX "Practice_tenantId_createdAt_idx" ON "Practice"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "Practice_tenantId_status_idx" ON "Practice"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Practice_tenantId_applicability_idx" ON "Practice"("tenantId", "applicability");

-- CreateIndex
CREATE INDEX "Practice_ownerUserId_idx" ON "Practice"("ownerUserId");

-- CreateIndex
CREATE INDEX "Practice_nextDueAt_idx" ON "Practice"("nextDueAt");

-- CreateIndex
CREATE INDEX "Practice_tenantId_deletedAt_idx" ON "Practice"("tenantId", "deletedAt");

-- CreateIndex
CREATE INDEX "Practice_tenantId_ownerUserId_idx" ON "Practice"("tenantId", "ownerUserId");

-- CreateIndex
CREATE INDEX "Practice_tenantId_category_idx" ON "Practice"("tenantId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "Practice_id_tenantId_key" ON "Practice"("id", "tenantId");

-- CreateIndex
CREATE INDEX "PracticeAsset_tenantId_assetId_idx" ON "PracticeAsset"("tenantId", "assetId");

-- CreateIndex
CREATE INDEX "PracticeAsset_tenantId_idx" ON "PracticeAsset"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeAsset_tenantId_practiceId_assetId_key" ON "PracticeAsset"("tenantId", "practiceId", "assetId");

-- CreateIndex
CREATE INDEX "PracticeTask_tenantId_idx" ON "PracticeTask"("tenantId");

-- CreateIndex
CREATE INDEX "PracticeTask_practiceId_idx" ON "PracticeTask"("practiceId");

-- CreateIndex
CREATE INDEX "PracticeTask_status_idx" ON "PracticeTask"("status");

-- CreateIndex
CREATE INDEX "PracticeTask_dueAt_idx" ON "PracticeTask"("dueAt");

-- CreateIndex
CREATE INDEX "PracticeTask_tenantId_status_dueAt_idx" ON "PracticeTask"("tenantId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "PracticeEvidenceLink_tenantId_idx" ON "PracticeEvidenceLink"("tenantId");

-- CreateIndex
CREATE INDEX "PracticeEvidenceLink_practiceId_idx" ON "PracticeEvidenceLink"("practiceId");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeEvidenceLink_practiceId_kind_fileId_key" ON "PracticeEvidenceLink"("practiceId", "kind", "fileId");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeEvidenceLink_practiceId_kind_url_key" ON "PracticeEvidenceLink"("practiceId", "kind", "url");

-- CreateIndex
CREATE UNIQUE INDEX "Policy_currentVersionId_key" ON "Policy"("currentVersionId");

-- CreateIndex
CREATE INDEX "Policy_tenantId_slug_idx" ON "Policy"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "Policy_tenantId_idx" ON "Policy"("tenantId");

-- CreateIndex
CREATE INDEX "Policy_tenantId_createdAt_idx" ON "Policy"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "Policy_tenantId_updatedAt_idx" ON "Policy"("tenantId", "updatedAt");

-- CreateIndex
CREATE INDEX "Policy_tenantId_status_idx" ON "Policy"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Policy_tenantId_category_idx" ON "Policy"("tenantId", "category");

-- CreateIndex
CREATE INDEX "Policy_nextReviewAt_idx" ON "Policy"("nextReviewAt");

-- CreateIndex
CREATE INDEX "Policy_tenantId_deletedAt_idx" ON "Policy"("tenantId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Policy_id_tenantId_key" ON "Policy"("id", "tenantId");

-- CreateIndex
CREATE INDEX "PolicyVersion_tenantId_idx" ON "PolicyVersion"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyVersion_policyId_versionNumber_key" ON "PolicyVersion"("policyId", "versionNumber");

-- CreateIndex
CREATE INDEX "PolicyApproval_tenantId_policyId_idx" ON "PolicyApproval"("tenantId", "policyId");

-- CreateIndex
CREATE INDEX "PolicyApproval_tenantId_policyVersionId_idx" ON "PolicyApproval"("tenantId", "policyVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyAcknowledgement_policyVersionId_userId_key" ON "PolicyAcknowledgement"("policyVersionId", "userId");

-- CreateIndex
CREATE INDEX "PolicyPracticeLink_tenantId_idx" ON "PolicyPracticeLink"("tenantId");

-- CreateIndex
CREATE INDEX "PolicyPracticeLink_tenantId_policyId_idx" ON "PolicyPracticeLink"("tenantId", "policyId");

-- CreateIndex
CREATE INDEX "PolicyPracticeLink_tenantId_practiceId_idx" ON "PolicyPracticeLink"("tenantId", "practiceId");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyPracticeLink_policyId_practiceId_key" ON "PolicyPracticeLink"("policyId", "practiceId");

-- CreateIndex
CREATE INDEX "Finding_tenantId_idx" ON "Finding"("tenantId");

-- CreateIndex
CREATE INDEX "Finding_tenantId_createdAt_idx" ON "Finding"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "Finding_tenantId_deletedAt_idx" ON "Finding"("tenantId", "deletedAt");

-- CreateIndex
CREATE INDEX "Finding_tenantId_auditId_idx" ON "Finding"("tenantId", "auditId");

-- CreateIndex
CREATE INDEX "Finding_tenantId_assigneeUserId_idx" ON "Finding"("tenantId", "assigneeUserId");

-- CreateIndex
CREATE INDEX "Finding_tenantId_practiceId_idx" ON "Finding"("tenantId", "practiceId");

-- CreateIndex
CREATE INDEX "Finding_tenantId_compensatingPracticeId_idx" ON "Finding"("tenantId", "compensatingPracticeId");

-- CreateIndex
CREATE INDEX "Finding_tenantId_dueDate_idx" ON "Finding"("tenantId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "Finding_id_tenantId_key" ON "Finding"("id", "tenantId");

-- CreateIndex
CREATE INDEX "FindingEvidence_tenantId_idx" ON "FindingEvidence"("tenantId");

-- CreateIndex
CREATE INDEX "FindingEvidence_tenantId_findingId_idx" ON "FindingEvidence"("tenantId", "findingId");

-- CreateIndex
CREATE INDEX "FindingEvidence_tenantId_evidenceId_idx" ON "FindingEvidence"("tenantId", "evidenceId");

-- CreateIndex
CREATE UNIQUE INDEX "FindingEvidence_findingId_evidenceId_key" ON "FindingEvidence"("findingId", "evidenceId");

-- CreateIndex
CREATE UNIQUE INDEX "Framework_key_version_key" ON "Framework"("key", "version");

-- CreateIndex
CREATE UNIQUE INDEX "FrameworkRequirement_frameworkId_code_key" ON "FrameworkRequirement"("frameworkId", "code");

-- CreateIndex
CREATE INDEX "FrameworkRequirementOrder_tenantId_idx" ON "FrameworkRequirementOrder"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "FrameworkRequirementOrder_tenantId_requirementId_key" ON "FrameworkRequirementOrder"("tenantId", "requirementId");

-- CreateIndex
CREATE UNIQUE INDEX "FrameworkPack_key_key" ON "FrameworkPack"("key");

-- CreateIndex
CREATE UNIQUE INDEX "FrameworkMapping_fromRequirementId_toPracticeId_key" ON "FrameworkMapping"("fromRequirementId", "toPracticeId");

-- CreateIndex
CREATE INDEX "RequirementMappingSet_sourceFrameworkId_idx" ON "RequirementMappingSet"("sourceFrameworkId");

-- CreateIndex
CREATE INDEX "RequirementMappingSet_targetFrameworkId_idx" ON "RequirementMappingSet"("targetFrameworkId");

-- CreateIndex
CREATE UNIQUE INDEX "RequirementMappingSet_sourceFrameworkId_targetFrameworkId_key" ON "RequirementMappingSet"("sourceFrameworkId", "targetFrameworkId");

-- CreateIndex
CREATE INDEX "RequirementMapping_sourceRequirementId_idx" ON "RequirementMapping"("sourceRequirementId");

-- CreateIndex
CREATE INDEX "RequirementMapping_targetRequirementId_idx" ON "RequirementMapping"("targetRequirementId");

-- CreateIndex
CREATE INDEX "RequirementMapping_mappingSetId_idx" ON "RequirementMapping"("mappingSetId");

-- CreateIndex
CREATE INDEX "RequirementMapping_validTo_idx" ON "RequirementMapping"("validTo");

-- CreateIndex
CREATE UNIQUE INDEX "RequirementMapping_mappingSetId_sourceRequirementId_targetR_key" ON "RequirementMapping"("mappingSetId", "sourceRequirementId", "targetRequirementId");

-- CreateIndex
CREATE INDEX "PracticeRequirementLink_tenantId_requirementId_idx" ON "PracticeRequirementLink"("tenantId", "requirementId");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeRequirementLink_practiceId_requirementId_key" ON "PracticeRequirementLink"("practiceId", "requirementId");

-- CreateIndex
CREATE INDEX "TreatmentMilestone_tenantId_treatmentPlanId_idx" ON "TreatmentMilestone"("tenantId", "treatmentPlanId");

-- CreateIndex
CREATE INDEX "TreatmentMilestone_tenantId_dueDate_idx" ON "TreatmentMilestone"("tenantId", "dueDate");

-- CreateIndex
CREATE INDEX "TreatmentMilestone_tenantId_completedAt_idx" ON "TreatmentMilestone"("tenantId", "completedAt");

-- CreateIndex
CREATE INDEX "TreatmentMilestone_treatmentPlanId_sortOrder_idx" ON "TreatmentMilestone"("treatmentPlanId", "sortOrder");

-- CreateIndex
CREATE INDEX "Vendor_tenantId_idx" ON "Vendor"("tenantId");

-- CreateIndex
CREATE INDEX "Vendor_tenantId_createdAt_idx" ON "Vendor"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "Vendor_tenantId_status_idx" ON "Vendor"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Vendor_tenantId_criticality_idx" ON "Vendor"("tenantId", "criticality");

-- CreateIndex
CREATE INDEX "Vendor_tenantId_nextReviewAt_idx" ON "Vendor"("tenantId", "nextReviewAt");

-- CreateIndex
CREATE INDEX "Vendor_tenantId_contractRenewalAt_idx" ON "Vendor"("tenantId", "contractRenewalAt");

-- CreateIndex
CREATE INDEX "Vendor_tenantId_deletedAt_idx" ON "Vendor"("tenantId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_tenantId_name_key" ON "Vendor"("tenantId", "name");

-- CreateIndex
CREATE INDEX "VendorContact_tenantId_vendorId_idx" ON "VendorContact"("tenantId", "vendorId");

-- CreateIndex
CREATE INDEX "VendorDocument_tenantId_vendorId_idx" ON "VendorDocument"("tenantId", "vendorId");

-- CreateIndex
CREATE INDEX "VendorDocument_tenantId_vendorId_type_idx" ON "VendorDocument"("tenantId", "vendorId", "type");

-- CreateIndex
CREATE INDEX "VendorDocument_tenantId_vendorId_folder_idx" ON "VendorDocument"("tenantId", "vendorId", "folder");

-- CreateIndex
CREATE INDEX "VendorDocument_tenantId_validTo_idx" ON "VendorDocument"("tenantId", "validTo");

-- CreateIndex
CREATE UNIQUE INDEX "QuestionnaireTemplate_key_key" ON "QuestionnaireTemplate"("key");

-- CreateIndex
CREATE INDEX "QuestionnaireQuestion_templateId_section_sortOrder_idx" ON "QuestionnaireQuestion"("templateId", "section", "sortOrder");

-- CreateIndex
CREATE INDEX "VendorAssessmentTemplate_tenantId_idx" ON "VendorAssessmentTemplate"("tenantId");

-- CreateIndex
CREATE INDEX "VendorAssessmentTemplate_tenantId_isLatestVersion_idx" ON "VendorAssessmentTemplate"("tenantId", "isLatestVersion");

-- CreateIndex
CREATE INDEX "VendorAssessmentTemplate_tenantId_isPublished_idx" ON "VendorAssessmentTemplate"("tenantId", "isPublished");

-- CreateIndex
CREATE UNIQUE INDEX "VendorAssessmentTemplate_tenantId_key_version_key" ON "VendorAssessmentTemplate"("tenantId", "key", "version");

-- CreateIndex
CREATE INDEX "VendorAssessmentTemplateSection_tenantId_templateId_sortOrd_idx" ON "VendorAssessmentTemplateSection"("tenantId", "templateId", "sortOrder");

-- CreateIndex
CREATE INDEX "VendorAssessmentTemplateQuestion_tenantId_templateId_sortOr_idx" ON "VendorAssessmentTemplateQuestion"("tenantId", "templateId", "sortOrder");

-- CreateIndex
CREATE INDEX "VendorAssessmentTemplateQuestion_tenantId_sectionId_sortOrd_idx" ON "VendorAssessmentTemplateQuestion"("tenantId", "sectionId", "sortOrder");

-- CreateIndex
CREATE INDEX "VendorAssessment_tenantId_vendorId_idx" ON "VendorAssessment"("tenantId", "vendorId");

-- CreateIndex
CREATE INDEX "VendorAssessment_tenantId_status_idx" ON "VendorAssessment"("tenantId", "status");

-- CreateIndex
CREATE INDEX "VendorAssessment_tenantId_riskRating_idx" ON "VendorAssessment"("tenantId", "riskRating");

-- CreateIndex
CREATE INDEX "VendorAssessment_externalAccessTokenHash_idx" ON "VendorAssessment"("externalAccessTokenHash");

-- CreateIndex
CREATE INDEX "VendorAssessmentAnswer_tenantId_assessmentId_idx" ON "VendorAssessmentAnswer"("tenantId", "assessmentId");

-- CreateIndex
CREATE INDEX "VendorAssessmentAnswer_tenantId_templateQuestionId_idx" ON "VendorAssessmentAnswer"("tenantId", "templateQuestionId");

-- CreateIndex
CREATE UNIQUE INDEX "VendorAssessmentAnswer_assessmentId_questionId_key" ON "VendorAssessmentAnswer"("assessmentId", "questionId");

-- CreateIndex
CREATE INDEX "VendorLink_tenantId_vendorId_idx" ON "VendorLink"("tenantId", "vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "VendorLink_tenantId_vendorId_entityType_entityId_key" ON "VendorLink"("tenantId", "vendorId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "VendorEvidenceBundle_tenantId_vendorId_idx" ON "VendorEvidenceBundle"("tenantId", "vendorId");

-- CreateIndex
CREATE INDEX "VendorEvidenceBundleItem_tenantId_bundleId_idx" ON "VendorEvidenceBundleItem"("tenantId", "bundleId");

-- CreateIndex
CREATE UNIQUE INDEX "VendorEvidenceBundleItem_bundleId_entityType_entityId_key" ON "VendorEvidenceBundleItem"("bundleId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "VendorRelationship_tenantId_primaryVendorId_idx" ON "VendorRelationship"("tenantId", "primaryVendorId");

-- CreateIndex
CREATE INDEX "VendorRelationship_tenantId_subprocessorVendorId_idx" ON "VendorRelationship"("tenantId", "subprocessorVendorId");

-- CreateIndex
CREATE UNIQUE INDEX "VendorRelationship_tenantId_primaryVendorId_subprocessorVen_key" ON "VendorRelationship"("tenantId", "primaryVendorId", "subprocessorVendorId");

-- CreateIndex
CREATE INDEX "AssetMaintenance_tenantId_vendorId_idx" ON "AssetMaintenance"("tenantId", "vendorId");

-- CreateIndex
CREATE INDEX "IntegrationExecution_tenantId_practiceId_idx" ON "IntegrationExecution"("tenantId", "practiceId");

-- CreateIndex
CREATE INDEX "ProcessEdgePractice_tenantId_practiceId_idx" ON "ProcessEdgePractice"("tenantId", "practiceId");

-- CreateIndex
CREATE INDEX "Evidence_tenantId_practiceId_idx" ON "Evidence"("tenantId", "practiceId");

-- CreateIndex
CREATE UNIQUE INDEX "Evidence_tenantId_sourceLogEntryId_practiceId_key" ON "Evidence"("tenantId", "sourceLogEntryId", "practiceId");

-- CreateIndex
CREATE INDEX "Task_tenantId_practiceId_idx" ON "Task"("tenantId", "practiceId");

-- CreateIndex
CREATE INDEX "Task_tenantId_practiceId_status_idx" ON "Task"("tenantId", "practiceId", "status");

-- AddForeignKey
ALTER TABLE "AssetMaintenance" ADD CONSTRAINT "AssetMaintenance_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Audit" ADD CONSTRAINT "Audit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditChecklistItem" ADD CONSTRAINT "AuditChecklistItem_auditId_tenantId_fkey" FOREIGN KEY ("auditId", "tenantId") REFERENCES "Audit"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditChecklistItem" ADD CONSTRAINT "AuditChecklistItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditCycle" ADD CONSTRAINT "AuditCycle_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditCycle" ADD CONSTRAINT "AuditCycle_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditPack" ADD CONSTRAINT "AuditPack_auditCycleId_fkey" FOREIGN KEY ("auditCycleId") REFERENCES "AuditCycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditPack" ADD CONSTRAINT "AuditPack_frozenByUserId_fkey" FOREIGN KEY ("frozenByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditPack" ADD CONSTRAINT "AuditPack_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditPackItem" ADD CONSTRAINT "AuditPackItem_auditPackId_fkey" FOREIGN KEY ("auditPackId") REFERENCES "AuditPack"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditPackItem" ADD CONSTRAINT "AuditPackItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditPackShare" ADD CONSTRAINT "AuditPackShare_auditPackId_fkey" FOREIGN KEY ("auditPackId") REFERENCES "AuditPack"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditPackShare" ADD CONSTRAINT "AuditPackShare_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditPackShare" ADD CONSTRAINT "AuditPackShare_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditorAccount" ADD CONSTRAINT "AuditorAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditorPackAccess" ADD CONSTRAINT "AuditorPackAccess_auditPackId_tenantId_fkey" FOREIGN KEY ("auditPackId", "tenantId") REFERENCES "AuditPack"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditorPackAccess" ADD CONSTRAINT "AuditorPackAccess_auditorId_tenantId_fkey" FOREIGN KEY ("auditorId", "tenantId") REFERENCES "AuditorAccount"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditorPackAccess" ADD CONSTRAINT "AuditorPackAccess_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReadinessSnapshot" ADD CONSTRAINT "ReadinessSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReadinessSnapshot" ADD CONSTRAINT "ReadinessSnapshot_auditCycleId_fkey" FOREIGN KEY ("auditCycleId") REFERENCES "AuditCycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationExecution" ADD CONSTRAINT "IntegrationExecution_practiceId_fkey" FOREIGN KEY ("practiceId") REFERENCES "Practice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClauseProgress" ADD CONSTRAINT "ClauseProgress_clauseId_fkey" FOREIGN KEY ("clauseId") REFERENCES "Clause"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClauseProgress" ADD CONSTRAINT "ClauseProgress_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Practice" ADD CONSTRAINT "Practice_applicabilityDecidedByUserId_fkey" FOREIGN KEY ("applicabilityDecidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Practice" ADD CONSTRAINT "Practice_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Practice" ADD CONSTRAINT "Practice_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Practice" ADD CONSTRAINT "Practice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeAsset" ADD CONSTRAINT "PracticeAsset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeAsset" ADD CONSTRAINT "PracticeAsset_practiceId_fkey" FOREIGN KEY ("practiceId") REFERENCES "Practice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeAsset" ADD CONSTRAINT "PracticeAsset_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeAsset" ADD CONSTRAINT "PracticeAsset_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeTask" ADD CONSTRAINT "PracticeTask_assigneeUserId_fkey" FOREIGN KEY ("assigneeUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeTask" ADD CONSTRAINT "PracticeTask_practiceId_fkey" FOREIGN KEY ("practiceId") REFERENCES "Practice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeTask" ADD CONSTRAINT "PracticeTask_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeEvidenceLink" ADD CONSTRAINT "PracticeEvidenceLink_practiceId_fkey" FOREIGN KEY ("practiceId") REFERENCES "Practice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeEvidenceLink" ADD CONSTRAINT "PracticeEvidenceLink_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeEvidenceLink" ADD CONSTRAINT "PracticeEvidenceLink_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Policy" ADD CONSTRAINT "Policy_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "PolicyVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Policy" ADD CONSTRAINT "Policy_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Policy" ADD CONSTRAINT "Policy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyVersion" ADD CONSTRAINT "PolicyVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyVersion" ADD CONSTRAINT "PolicyVersion_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "Policy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyVersion" ADD CONSTRAINT "PolicyVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyApproval" ADD CONSTRAINT "PolicyApproval_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyApproval" ADD CONSTRAINT "PolicyApproval_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "Policy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyApproval" ADD CONSTRAINT "PolicyApproval_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "PolicyVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyApproval" ADD CONSTRAINT "PolicyApproval_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyApproval" ADD CONSTRAINT "PolicyApproval_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyAcknowledgement" ADD CONSTRAINT "PolicyAcknowledgement_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "PolicyVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyAcknowledgement" ADD CONSTRAINT "PolicyAcknowledgement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyPracticeLink" ADD CONSTRAINT "PolicyPracticeLink_practiceId_fkey" FOREIGN KEY ("practiceId") REFERENCES "Practice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyPracticeLink" ADD CONSTRAINT "PolicyPracticeLink_policyId_tenantId_fkey" FOREIGN KEY ("policyId", "tenantId") REFERENCES "Policy"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyPracticeLink" ADD CONSTRAINT "PolicyPracticeLink_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "Audit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_assigneeUserId_fkey" FOREIGN KEY ("assigneeUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_practiceId_fkey" FOREIGN KEY ("practiceId") REFERENCES "Practice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_compensatingPracticeId_fkey" FOREIGN KEY ("compensatingPracticeId") REFERENCES "Practice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingEvidence" ADD CONSTRAINT "FindingEvidence_evidenceId_tenantId_fkey" FOREIGN KEY ("evidenceId", "tenantId") REFERENCES "Evidence"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingEvidence" ADD CONSTRAINT "FindingEvidence_findingId_tenantId_fkey" FOREIGN KEY ("findingId", "tenantId") REFERENCES "Finding"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingEvidence" ADD CONSTRAINT "FindingEvidence_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrameworkRequirement" ADD CONSTRAINT "FrameworkRequirement_frameworkId_fkey" FOREIGN KEY ("frameworkId") REFERENCES "Framework"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrameworkRequirementOrder" ADD CONSTRAINT "FrameworkRequirementOrder_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrameworkRequirementOrder" ADD CONSTRAINT "FrameworkRequirementOrder_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "FrameworkRequirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrameworkPack" ADD CONSTRAINT "FrameworkPack_frameworkId_fkey" FOREIGN KEY ("frameworkId") REFERENCES "Framework"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrameworkMapping" ADD CONSTRAINT "FrameworkMapping_fromRequirementId_fkey" FOREIGN KEY ("fromRequirementId") REFERENCES "FrameworkRequirement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrameworkMapping" ADD CONSTRAINT "FrameworkMapping_toPracticeId_fkey" FOREIGN KEY ("toPracticeId") REFERENCES "Practice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrameworkMapping" ADD CONSTRAINT "FrameworkMapping_toRequirementId_fkey" FOREIGN KEY ("toRequirementId") REFERENCES "FrameworkRequirement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequirementMappingSet" ADD CONSTRAINT "RequirementMappingSet_sourceFrameworkId_fkey" FOREIGN KEY ("sourceFrameworkId") REFERENCES "Framework"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequirementMappingSet" ADD CONSTRAINT "RequirementMappingSet_targetFrameworkId_fkey" FOREIGN KEY ("targetFrameworkId") REFERENCES "Framework"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequirementMapping" ADD CONSTRAINT "RequirementMapping_mappingSetId_fkey" FOREIGN KEY ("mappingSetId") REFERENCES "RequirementMappingSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequirementMapping" ADD CONSTRAINT "RequirementMapping_sourceRequirementId_fkey" FOREIGN KEY ("sourceRequirementId") REFERENCES "FrameworkRequirement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequirementMapping" ADD CONSTRAINT "RequirementMapping_targetRequirementId_fkey" FOREIGN KEY ("targetRequirementId") REFERENCES "FrameworkRequirement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeRequirementLink" ADD CONSTRAINT "PracticeRequirementLink_practiceId_fkey" FOREIGN KEY ("practiceId") REFERENCES "Practice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeRequirementLink" ADD CONSTRAINT "PracticeRequirementLink_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "FrameworkRequirement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeRequirementLink" ADD CONSTRAINT "PracticeRequirementLink_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreatmentMilestone" ADD CONSTRAINT "TreatmentMilestone_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreatmentMilestone" ADD CONSTRAINT "TreatmentMilestone_completedByUserId_fkey" FOREIGN KEY ("completedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_practiceId_fkey" FOREIGN KEY ("practiceId") REFERENCES "Practice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorContact" ADD CONSTRAINT "VendorContact_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorContact" ADD CONSTRAINT "VendorContact_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorDocument" ADD CONSTRAINT "VendorDocument_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorDocument" ADD CONSTRAINT "VendorDocument_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorDocument" ADD CONSTRAINT "VendorDocument_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionnaireQuestion" ADD CONSTRAINT "QuestionnaireQuestion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "QuestionnaireTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAssessmentTemplate" ADD CONSTRAINT "VendorAssessmentTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAssessmentTemplate" ADD CONSTRAINT "VendorAssessmentTemplate_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAssessmentTemplateSection" ADD CONSTRAINT "VendorAssessmentTemplateSection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAssessmentTemplateSection" ADD CONSTRAINT "VendorAssessmentTemplateSection_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "VendorAssessmentTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAssessmentTemplateQuestion" ADD CONSTRAINT "VendorAssessmentTemplateQuestion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAssessmentTemplateQuestion" ADD CONSTRAINT "VendorAssessmentTemplateQuestion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "VendorAssessmentTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAssessmentTemplateQuestion" ADD CONSTRAINT "VendorAssessmentTemplateQuestion_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "VendorAssessmentTemplateSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAssessment" ADD CONSTRAINT "VendorAssessment_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAssessment" ADD CONSTRAINT "VendorAssessment_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAssessment" ADD CONSTRAINT "VendorAssessment_sentByUserId_fkey" FOREIGN KEY ("sentByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAssessment" ADD CONSTRAINT "VendorAssessment_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAssessment" ADD CONSTRAINT "VendorAssessment_closedByUserId_fkey" FOREIGN KEY ("closedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAssessment" ADD CONSTRAINT "VendorAssessment_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "QuestionnaireTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAssessment" ADD CONSTRAINT "VendorAssessment_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "VendorAssessmentTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAssessment" ADD CONSTRAINT "VendorAssessment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAssessment" ADD CONSTRAINT "VendorAssessment_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAssessmentAnswer" ADD CONSTRAINT "VendorAssessmentAnswer_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "VendorAssessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAssessmentAnswer" ADD CONSTRAINT "VendorAssessmentAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "QuestionnaireQuestion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAssessmentAnswer" ADD CONSTRAINT "VendorAssessmentAnswer_templateQuestionId_fkey" FOREIGN KEY ("templateQuestionId") REFERENCES "VendorAssessmentTemplateQuestion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAssessmentAnswer" ADD CONSTRAINT "VendorAssessmentAnswer_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "Evidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAssessmentAnswer" ADD CONSTRAINT "VendorAssessmentAnswer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorLink" ADD CONSTRAINT "VendorLink_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorLink" ADD CONSTRAINT "VendorLink_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorEvidenceBundle" ADD CONSTRAINT "VendorEvidenceBundle_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorEvidenceBundle" ADD CONSTRAINT "VendorEvidenceBundle_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorEvidenceBundle" ADD CONSTRAINT "VendorEvidenceBundle_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorEvidenceBundleItem" ADD CONSTRAINT "VendorEvidenceBundleItem_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "VendorEvidenceBundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorEvidenceBundleItem" ADD CONSTRAINT "VendorEvidenceBundleItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorRelationship" ADD CONSTRAINT "VendorRelationship_primaryVendorId_fkey" FOREIGN KEY ("primaryVendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorRelationship" ADD CONSTRAINT "VendorRelationship_subprocessorVendorId_fkey" FOREIGN KEY ("subprocessorVendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorRelationship" ADD CONSTRAINT "VendorRelationship_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_practiceId_fkey" FOREIGN KEY ("practiceId") REFERENCES "Practice"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Bookkeeping ──────────────────────────────────────────────────────
-- See the header: without this, a later roll-forward silently skips
-- phase 3 and leaves new code on the old schema.
DELETE FROM "_prisma_migrations"
 WHERE "migration_name" = '20260815120000_grc_teardown_phase3';

COMMIT;
