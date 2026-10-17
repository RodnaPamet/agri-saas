-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK — undo `20261017110000_p6_3_drop_redundant_content_sha256`
-- ═══════════════════════════════════════════════════════════════════════
--
-- WHY THIS FILE EXISTS
--
-- Pinning Watchtower to the previous image does NOT undo a migration. The
-- rule in `deploy/rollback/README.md` applies to every DROP, and this one
-- drops `FileRecord.contentSha256`.
--
-- ── WHAT THIS RESTORES, AND WHAT IT DOES NOT ─────────────────────────
--
-- RESTORES: the column, nullable, and its index — the exact shape the
-- previous image's Prisma client was generated against.
--
-- DOES NOT RESTORE: row data. There is none to restore, and for once that is
-- a fact rather than a hope. The column shipped in the migration immediately
-- before this one (20261016090000), deliberately a release ahead of the image
-- pipeline that was to write it, and that pipeline does not exist yet. So the
-- column was `NULL` on every row for the whole of its life.
--
-- ── WHY THE COLUMN WENT AWAY ────────────────────────────────────────
--
-- It duplicated `FileRecord.sha256`, which this table has always carried:
-- `NOT NULL`, and populated at every upload call site from
-- `writeResult.sha256` — the storage provider's digest of the bytes it just
-- wrote. `/api/public/media/[hash]` needs a content hash to resolve, and that
-- was already it.
--
-- The duplicate was strictly worse than the column it shadowed. A fresh
-- nullable column is empty for every file uploaded before the pipeline ships,
-- so the media route would have had to treat an absent hash as unservable —
-- a surface that silently serves nothing, which is the dark-launch shape this
-- phase has already tripped over three times (#2009). `sha256` is populated
-- for every existing file, so the route needs no backfill and no null branch.
--
-- Rolling this back therefore restores a mistake's shape, not its content.
-- Run it only to make an older image boot.
--
-- ── THE `_prisma_migrations` ROW ──────────────────────────────────────
--
-- The last statement deletes the migration's bookkeeping row, and it is
-- load-bearing rather than tidy-up. `prisma migrate deploy` decides what to
-- run by consulting that table. Leave the row and a later roll-forward SKIPS
-- this migration as already-applied — new code, old schema. Deleting it means
-- redeploying simply re-applies the drop and recovers.
--
-- down → up → down all work: every statement here and in the forward
-- migration is `IF EXISTS` / `IF NOT EXISTS` guarded.

BEGIN;

-- AlterTable — restore the redundant column and its index.
ALTER TABLE "FileRecord" ADD COLUMN IF NOT EXISTS "contentSha256" TEXT;
CREATE INDEX IF NOT EXISTS "FileRecord_contentSha256_idx" ON "FileRecord"("contentSha256");

-- Drop the index this migration added. A performance object only: without it
-- the public media route's lookup is a sequential scan rather than broken.
DROP INDEX IF EXISTS "FileRecord_sha256_idx";

-- ── Bookkeeping ──────────────────────────────────────────────────────
-- See the header: without this, a later roll-forward silently skips the drop.
DELETE FROM "_prisma_migrations"
 WHERE "migration_name" = '20261017110000_p6_3_drop_redundant_content_sha256';

COMMIT;
