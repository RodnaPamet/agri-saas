-- P6.3 (#1812) — remove `FileRecord.contentSha256`, added one migration ago,
-- and index the hash this table has always carried instead.
--
-- ## What I got wrong
--
-- 20261016090000 added `contentSha256` so `/api/public/media/[hash]` would
-- have a hash to resolve. `FileRecord.sha256` already is that hash: it is
-- `NOT NULL`, and every upload path populates it from `writeResult.sha256` —
-- the storage provider's digest of the bytes it just wrote. Measured at all
-- six call sites (evidence ×3, journal, cost-entry, spatial-import).
--
-- So the new column was a second name for an existing fact, and the index was
-- on the wrong one.
--
-- ## This is better for the feature than the column was
--
-- `sha256` is populated for EVERY file that already exists, so the media
-- route needs no backfill and no "null means not processed yet" branch. A
-- fresh nullable column would have been empty for every file uploaded before
-- the pipeline shipped, and the route would have had to treat an absent hash
-- as unservable — which is exactly the dark-launch shape this phase keeps
-- tripping over.
--
-- ## Dropping is safe here specifically
--
-- Nothing ever read or wrote it. It shipped in the migration immediately
-- before this one, deliberately a release ahead of any writer, and that
-- writer does not exist yet. There is no data in it to lose in production —
-- it is `NULL` on every row by construction.
DROP INDEX IF EXISTS "FileRecord_contentSha256_idx";
ALTER TABLE "FileRecord" DROP COLUMN IF EXISTS "contentSha256";

-- The index the route actually needs. Tenantless, unlike every other index on
-- this table, because the public media route has no tenant in scope.
--
-- NOT unique, and that is a requirement rather than an omission: two tenants
-- can legitimately upload the same image, and a unique constraint would make
-- the second upload fail.
CREATE INDEX IF NOT EXISTS "FileRecord_sha256_idx" ON "FileRecord"("sha256");
