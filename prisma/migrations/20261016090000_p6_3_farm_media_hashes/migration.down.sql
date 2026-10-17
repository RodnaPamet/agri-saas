-- Rollback for 20261016090000_p6_3_farm_media_hashes.
--
-- Safe for exactly one release — the window this migration was split out to
-- create. Nothing writes these columns yet, so dropping them loses nothing.
--
-- Once the sharp pipeline ships, the two directions diverge sharply and are
-- worth naming separately:
--
--   `FileRecord.contentSha256` — dropping it ORPHANS the bytes. The file rows
--   survive, but nothing can look a processed image up by hash any more, so
--   every published logo and photo 404s. Recoverable: the hash is a pure
--   function of bytes already in storage, so a re-scan can rebuild the column.
--
--   `FarmBrand.*MediaHashes` — dropping these loses a CHOICE, and that is the
--   unrecoverable direction. Which photographs a farm selected and the order
--   it put them in exist nowhere else; the bytes remain in storage as an
--   undifferentiated set. A rollback after farms have curated galleries would
--   require every farm to pick and reorder its photos again.
--
--   `PublicFarmProfile.*MediaHashes` — harmless on its own, since a projection
--   refresh rebuilds it from `FarmBrand`. It is only lost data if `FarmBrand`
--   went with it.
DROP INDEX IF EXISTS "FileRecord_contentSha256_idx";
ALTER TABLE "FileRecord" DROP COLUMN "contentSha256";
ALTER TABLE "PublicFarmProfile" DROP COLUMN "photoMediaHashes";
ALTER TABLE "PublicFarmProfile" DROP COLUMN "logoMediaHash";
ALTER TABLE "FarmBrand" DROP COLUMN "photoMediaHashes";
ALTER TABLE "FarmBrand" DROP COLUMN "logoMediaHash";
