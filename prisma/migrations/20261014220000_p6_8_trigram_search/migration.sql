-- ═══════════════════════════════════════════════════════════════════
-- P6.8 — trigram search over the public directory
-- ═══════════════════════════════════════════════════════════════════
--
-- SCHEMA ONLY. The projection writer populates `displayNameLatin` and
-- the search usecase reads it in the PR after this one, per the phase
-- rule that tables ship a release ahead of the code that writes them.
-- Nothing in src/ touches the new column after this migration.
--
-- ── the extension, checked on production first ──
--
-- Measured on prod 2026-10-14: PostgreSQL 16.15, `pg_trgm` AVAILABLE at
-- 1.6 and not installed. `datcollate` and `datctype` are both
-- `en_US.utf8` — not `C` — which is the thing the phase said to check
-- before enabling it, because a `C` ctype breaks case-insensitive
-- matching for Cyrillic and would have made this whole approach wrong.
--
-- `IF NOT EXISTS` because the test databases are migrated repeatedly
-- and a second run must not fail. It needs superuser or the
-- `pg_database_owner` role; the migration connection is the owner, the
-- same one that creates the RLS policies.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- AlterTable
ALTER TABLE "PublicFarmProfile" ADD COLUMN     "displayNameLatin" TEXT;
-- CreateIndex
CREATE INDEX "PublicFarmProfile_displayName_idx" ON "PublicFarmProfile" USING GIN ("displayName" gin_trgm_ops);
-- CreateIndex
CREATE INDEX "PublicFarmProfile_displayNameLatin_idx" ON "PublicFarmProfile" USING GIN ("displayNameLatin" gin_trgm_ops);

-- ── why a STORED Latin column and not a reversed query ──
--
-- `transliterate()` implements the Закон за транслитерацията (2009)
-- Streamlined System, so «Победа» yields `Pobeda` — the spelling on the
-- farmer's own passport and on the road signs.
--
-- It is NOT injective. Measured 2026-10-14 over the full alphabet:
--
--     'a' <- а , ъ
--     'y' <- й , ь
--
-- So a Latin `a` could be either `а` or `ъ`, and reversing `pobeda` into
-- Cyrillic has more than one answer. A search that normalised the QUERY
-- would therefore miss farms, silently, in a way no test of the happy
-- path would show. Transliterating the STORED name forward has exactly
-- one answer per input, which is why the Latin form is a column.
--
-- ── why gin_trgm_ops and not an equality index ──
--
-- A plain GIN index on text cannot serve `similarity()` or the `%`
-- operator; the operator class is what makes it usable. And similarity
-- rather than equality is load-bearing here, not a nicety:
-- «АгроТех» transliterates to `AgroTeh`, because `х → h` and
-- transliteration is not translation. A user typing the English-looking
-- `AgroTech` is doing an exact match against nothing — but the two
-- strings share almost all their trigrams, so similarity finds what
-- equality would quietly fail to.
--
-- Both columns are indexed: a Cyrillic query matches `displayName`, a
-- Latin one matches `displayNameLatin`, and nothing is ever reversed.
