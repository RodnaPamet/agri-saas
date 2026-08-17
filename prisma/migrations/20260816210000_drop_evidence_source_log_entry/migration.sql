-- Retire `Evidence.sourceLogEntryId`.
--
-- The column has had NO WRITER since GRC teardown phase 3. Its only one,
-- `attachAutoEvidenceFromLogEntry`, minted evidence by walking
-- Framework -> FrameworkRequirement -> PracticeRequirementLink -> Practice,
-- and phase 3 deleted every hop of that chain. So journal-derived evidence
-- stopped existing as a feature — as a side effect of the teardown rather
-- than by decision — and the column has been inert ever since.
--
-- What went with it in the same change: the two maintenance helpers that
-- kept such rows truthful (`syncDerivedEvidenceTitle`,
-- `setDerivedEvidenceWithdrawn`) and their three call sites in journal.ts,
-- the AUTO_FARM_RECORD category constant, the evidence-list deep link and
-- type-cell branches that could never be taken, and the third arm of the
-- READER/AUDITOR download-provenance gate.
--
-- THE GATE IS THE REASON THIS NEEDED A MEASUREMENT. `downloadEvidenceFile`
-- admits a READER/AUDITOR on `assetId ?? taskId ?? sourceLogEntryId`;
-- dropping the third arm narrows who can download pre-teardown farm
-- evidence. It is now `assetId ?? taskId`.
--
-- PRODUCTION PRE-FLIGHT (re-measured on inflect_production immediately
-- before writing this, not carried over from the phase-3 measurement):
--     Evidence total                                    0
--     has sourceLogEntryId                              0
--     ONLY sourceLogEntryId (would lose READER access)  0
-- No row loses access, because there are no rows.
--
-- ROLLBACK: deploy/rollback/20260816210000_drop_evidence_source_log_entry.down.sql
-- It restores the COLUMN, not the data — see its header.

-- DropIndex
DROP INDEX "Evidence_tenantId_sourceLogEntryId_idx";

-- DropIndex
DROP INDEX "Evidence_tenantId_sourceLogEntryId_key";

-- AlterTable
ALTER TABLE "Evidence" DROP COLUMN "sourceLogEntryId";
