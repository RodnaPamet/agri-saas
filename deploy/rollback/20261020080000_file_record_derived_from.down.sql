-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK — undo `20261020080000_file_record_derived_from`
-- ═══════════════════════════════════════════════════════════════════════
--
-- WHY THIS FILE EXISTS
--
-- Pinning Watchtower to the previous image does NOT undo a migration, and
-- `deploy/rollback/README.md` requires an inverse for every DROP.
--
-- ── WHAT THIS RESTORES, AND WHAT IT DOES NOT ─────────────────────────
--
-- RESTORES: nothing, because nothing is lost. The column ships one release
-- ahead of the only code that will read it, so at the moment this script is
-- runnable the column is NULL on every row by construction.
--
-- DOES NOT RESTORE: row data, once there is any. After the thumbnail pipeline
-- ships, dropping this column breaks the pairing between a photograph and its
-- thumbnail — and that direction is RECOVERABLE but not automatic: both files
-- still exist in storage and both `FileRecord` rows survive, but nothing says
-- which thumbnail belongs to which original, so the pairing has to be rebuilt
-- by re-deriving thumbnails from the originals.
--
-- The visible symptom in the meantime is the one worth naming: the projection
-- falls back to publishing the ORIGINAL hashes, so `/f/{handle}` serves
-- full-size photographs again and its LCP budget fails. The page works and is
-- slow, rather than breaking.
--
-- ── THE `_prisma_migrations` ROW ──────────────────────────────────────
--
-- The last statement deletes the migration's bookkeeping row, and it is
-- load-bearing rather than tidy-up. `prisma migrate deploy` decides what to
-- run by consulting that table, so leaving the row makes a later roll-forward
-- SKIP this migration as already-applied — new code, old schema. Deleting it
-- means redeploying simply re-applies the column.
--
-- down → up → down all work: both statements are guarded.

BEGIN;

DROP INDEX IF EXISTS "FileRecord_tenantId_derivedFromSha256_idx";
ALTER TABLE "FileRecord" DROP COLUMN IF EXISTS "derivedFromSha256";

-- ── Bookkeeping ──────────────────────────────────────────────────────
-- See the header: without this, a later roll-forward silently skips the add.
DELETE FROM "_prisma_migrations"
 WHERE "migration_name" = '20261020080000_file_record_derived_from';

COMMIT;
