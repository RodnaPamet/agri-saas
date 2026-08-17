-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK — undo `20260816210000_drop_evidence_source_log_entry`
-- ═══════════════════════════════════════════════════════════════════════
--
-- WHY THIS FILE EXISTS
--
-- Pinning Watchtower to the previous image does NOT undo a migration. The
-- previous image's Prisma client still SELECTs `Evidence.sourceLogEntryId`
-- — it is in `evidenceListSelect`, so it is on the hot path of the
-- `/evidence` list page, and in `downloadEvidenceFile`'s provenance query.
-- Without this script an image-only rollback does not degrade; the evidence
-- library 500s.
--
-- ── WHAT THIS RESTORES, AND WHAT IT DOES NOT ─────────────────────────
--
-- RESTORES: the column, its `(tenantId, sourceLogEntryId)` index and its
-- unique constraint — the SHAPE the previous image expects.
--
-- DOES NOT RESTORE: row data. A dropped column cannot be un-dropped with
-- its contents. This is acceptable only because the column was EMPTY:
-- production carried 0 Evidence rows when the forward migration ran
-- (re-measured immediately beforehand, not carried over from the phase-3
-- pre-flight). If you are reading this on a database where that was not
-- true, this script is NOT a sufficient rollback and you want a snapshot.
--
-- Restoring the column also does not restore the FEATURE. Nothing has
-- written it since phase 3 deleted `attachAutoEvidenceFromLogEntry` and the
-- Practice graph it walked, so a rolled-back image sees the column as it
-- last was: present, and empty.
--
-- ── HOW TO RUN ────────────────────────────────────────────────────────
--
--   1. Stop the app + worker first:
--        gcloud compute ssh agrent --zone europe-west1-b \
--          --command "cd /opt/agrent && sudo docker compose \
--            -f docker-compose.vm.yml stop app worker"
--
--   2. Apply against the DIRECT database URL (not PgBouncer — DDL in one
--      transaction):
--        psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 \
--          -f deploy/rollback/20260816210000_drop_evidence_source_log_entry.down.sql
--
--   3. Start the PREVIOUS image. Starting the new one re-applies the
--      forward migration and puts you back where you started.
--
-- The whole script is one transaction: Postgres DDL is transactional, so a
-- failure anywhere leaves the database exactly as it was.
--
-- ── THE `_prisma_migrations` ROW ──────────────────────────────────────
--
-- The last statement deletes the migration's bookkeeping row, and it is
-- load-bearing rather than tidy-up. `prisma migrate deploy` decides what to
-- run by consulting that table. Leave the row and a later roll-forward
-- SKIPS this migration as already-applied — new code, old schema, the same
-- outage in the opposite direction. Deleting it means redeploying the new
-- image simply re-applies the drop and recovers.
--
-- So this script is reversible: down → up → down all work.
--
-- ── A NOTE ON THE UNIQUE INDEX ────────────────────────────────────────
--
-- `CREATE UNIQUE INDEX` on a repopulated column would fail if two rows in
-- one tenant shared a `sourceLogEntryId`. They cannot here: the column comes
-- back NULL for every row, and NULLs do not collide in Postgres.

BEGIN;

-- AlterTable
ALTER TABLE "Evidence" ADD COLUMN     "sourceLogEntryId" TEXT;

-- CreateIndex
CREATE INDEX "Evidence_tenantId_sourceLogEntryId_idx" ON "Evidence"("tenantId", "sourceLogEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "Evidence_tenantId_sourceLogEntryId_key" ON "Evidence"("tenantId", "sourceLogEntryId");

-- ── Bookkeeping ──────────────────────────────────────────────────────
-- See the header: without this, a later roll-forward silently skips the
-- drop and leaves new code on the old schema.
DELETE FROM "_prisma_migrations"
 WHERE "migration_name" = '20260816210000_drop_evidence_source_log_entry';

COMMIT;
