-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK — undo `20260927180000_drop_farm_profile_location`
-- ═══════════════════════════════════════════════════════════════════════
--
-- WHY THIS FILE EXISTS
--
-- Pinning Watchtower to the previous image does NOT undo a migration. The
-- image immediately before this one shipped `FarmProfile.farmLocation` in its
-- Prisma client: `getFarmProfile` reduces over a PROFILE_FIELDS list that
-- includes it, and the admin farm-profile page renders an input bound to it.
-- Without this script an image-only rollback does not degrade gracefully —
-- the admin profile read fails on a column that is no longer there.
--
-- ── WHAT THIS RESTORES, AND WHAT IT DOES NOT ─────────────────────────
--
-- RESTORES: the column, nullable, exactly as it was. That is the SHAPE the
-- previous image expects, and the whole of what it needs.
--
-- DOES NOT RESTORE: row data. A dropped column cannot be un-dropped with its
-- contents.
--
-- That is acceptable here, and for a stronger reason than "the column was
-- empty". The forward migration COPIED every non-blank `farmLocation` into
-- `registrationPlace` before dropping it, and only where `registrationPlace`
-- was itself empty. So the value was not destroyed — it was moved to the
-- column that always meant this, and it is still on screen after a rollback,
-- one field further up the same form.
--
-- ── WHY THE COLUMN WENT AWAY AT ALL ─────────────────────────────────
--
-- It duplicated `registrationPlace`. "Location" on this page means where the
-- farm is REGISTERED — «Място на регистриране» on the БАБХ ДНЕВНИК form, held
-- in `registrationPlace` since that work landed. The new column had been
-- documented as "where the land is, distinct from the correspondence address",
-- which is the opposite, and nothing on the form means that. The warehouse the
-- registered place usually doubles as is «Склад за растителна продукция»,
-- which is recorded PER PARCEL as `Parcel.produceStore` and already prints on
-- the diary.
--
-- So a rollback that restores an empty duplicate column is restoring a
-- mistake's shape, not its content. Run it only to make an older image boot.
--
-- ── THE `_prisma_migrations` ROW ──────────────────────────────────────
--
-- The last statement deletes the migration's bookkeeping row, and it is
-- load-bearing rather than tidy-up. `prisma migrate deploy` decides what to
-- run by consulting that table. Leave the row and a later roll-forward SKIPS
-- this migration as already-applied — new code, old schema, the same outage in
-- the opposite direction. Deleting it means redeploying the new image simply
-- re-applies the drop and recovers.
--
-- So this script is reversible: down → up → down all work. Note the forward
-- migration's COPY is idempotent under that cycle — it only writes where
-- `registrationPlace` is empty, and after the first pass it no longer is.

BEGIN;

-- AlterTable
ALTER TABLE "FarmProfile" ADD COLUMN IF NOT EXISTS "farmLocation" TEXT;

-- ── Bookkeeping ──────────────────────────────────────────────────────
-- See the header: without this, a later roll-forward silently skips the drop
-- and leaves new code on the old schema.
DELETE FROM "_prisma_migrations"
 WHERE "migration_name" = '20260927180000_drop_farm_profile_location';

COMMIT;
