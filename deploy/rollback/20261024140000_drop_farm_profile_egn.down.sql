-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK — undo `20261024140000_drop_farm_profile_egn`
-- ═══════════════════════════════════════════════════════════════════════
--
-- WHY THIS FILE EXISTS
--
-- Pinning Watchtower to the previous image does NOT undo a migration. The
-- image immediately before this one shipped `FarmProfile.egn` in its Prisma
-- client, and `getFarmProfile` reduces over a PROFILE_FIELDS list that
-- includes it. The report read in `farm-record-diary.ts` is worse: it calls
-- `db.farmProfile.findUnique` with NO `select`, so Prisma names every column
-- it knows about and the statement fails outright on a column that is no
-- longer there. Without this script an image-only rollback does not degrade
-- gracefully — the admin profile page and the ДНЕВНИК PDF both stop working.
--
-- ── WHAT THIS RESTORES, AND WHAT IT DOES NOT ─────────────────────────
--
-- RESTORES: the column, nullable, exactly as it was. That is the SHAPE the
-- previous image expects, and the whole of what it needs to boot.
--
-- DOES NOT RESTORE: row data. Every value is gone and is not coming back.
--
-- This differs from `20260927180000_drop_farm_profile_location.down.sql`,
-- which is otherwise the same shape of change. THERE the forward migration
-- copied each value into `registrationPlace` first, so a rollback restored an
-- empty column and the data was still on screen one field up. HERE the
-- forward migration overwrote every value with NULL before dropping the
-- column, on purpose: the owner ruled on 2026-10-24 that the product does not
-- hold a Bulgarian national identity number, and erasing the values IS the
-- change. A rollback restoring them would be a rollback of a GDPR decision,
-- which is not a thing this file is willing to offer.
--
-- So: run this to make an older image boot. It gives that image an empty
-- column to select, and farmers whose ЕГН was erased stay erased. If an
-- older image is left running, its admin page shows an empty ЕГН field —
-- which is an input nobody is obliged to fill, since the paper form has
-- always tolerated blanks.
--
-- Anything that genuinely needs the values back needs a database restore
-- (docs/backup-restore.md) and a conversation with the owner about why a
-- deletion they ordered is being reversed — not this script.
--
-- ── THE `_prisma_migrations` ROW ──────────────────────────────────────
--
-- The last statement deletes the migration's bookkeeping row, and it is
-- load-bearing rather than tidy-up. `prisma migrate deploy` decides what to
-- run by consulting that table. Leave the row and a later roll-forward SKIPS
-- this migration as already-applied — new code, old schema, the same outage
-- in the opposite direction. Deleting it means redeploying the new image
-- re-applies the erase-and-drop and recovers.
--
-- Reversible as a cycle: down → up → down all work. The forward migration's
-- UPDATE is idempotent under that cycle — after a down the column is empty,
-- so the UPDATE matches nothing and the DROP does the rest.

BEGIN;

-- AlterTable
ALTER TABLE "FarmProfile" ADD COLUMN IF NOT EXISTS "egn" TEXT;

-- ── Bookkeeping ──────────────────────────────────────────────────────
-- See the header: without this, a later roll-forward silently skips the
-- erase-and-drop and leaves new code on the old schema.
DELETE FROM "_prisma_migrations"
 WHERE "migration_name" = '20261024140000_drop_farm_profile_egn';

COMMIT;
