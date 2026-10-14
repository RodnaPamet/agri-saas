-- Rollback for 20261014220000_p6_8_trigram_search.
--
-- Indexes and the column go; the EXTENSION stays. Dropping `pg_trgm`
-- would be destructive beyond this migration's scope — another
-- migration, another feature, or a hand-built index could depend on it,
-- and `DROP EXTENSION` without CASCADE fails while anything does while
-- WITH CASCADE silently removes whatever that is. An installed
-- extension nothing uses costs nothing.
DROP INDEX IF EXISTS "PublicFarmProfile_displayNameLatin_idx";
DROP INDEX IF EXISTS "PublicFarmProfile_displayName_idx";
ALTER TABLE "PublicFarmProfile" DROP COLUMN IF EXISTS "displayNameLatin";
