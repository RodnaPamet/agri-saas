-- Two changes to Framework, both about telling the truth over time.
--
-- 1. DROP the single-column unique on `key`.
--
--    `Framework` carried BOTH `@unique` on `key` and `@@unique([key, version])`.
--    The single-column one wins, so two versions of a standard could never
--    coexist — and bumping `version:` in a catalogue YAML hard-failed the
--    importer: `catalog-applier` upserts on `key_version`, misses (no row with
--    that version), tries to CREATE, and violates the key-only unique with
--    P2002. Standards revise annually; a product that cannot ingest a revision
--    is a product whose catalogue freezes on the day it ships.
--
--    The composite stays, so (key, version) is still unique — what changes is
--    that GlobalG.A.P. v6 and v6.1 can sit side by side.
--
-- 2. ADD `isDemo` + `coverageNote`.
--
--    The shipped catalogues are 3-8% stubs. The YAMLs say so in their headers;
--    nothing carried it into the database, so nothing could render it. A
--    farmer who maps their practices to 7 control points and sees
--    "GlobalG.A.P." will believe they are covered.

DROP INDEX IF EXISTS "Framework_key_key";

ALTER TABLE "Framework" ADD COLUMN IF NOT EXISTS "isDemo" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Framework" ADD COLUMN IF NOT EXISTS "coverageNote" TEXT;

-- Every framework shipped today is a demo subset. Marking them explicitly
-- rather than leaving the default false: false would claim the opposite of
-- what the YAML headers say.
UPDATE "Framework"
SET "isDemo" = true
WHERE "key" LIKE '%-DEMO' OR "key" LIKE '%-demo' OR lower("name") LIKE '%demo%';
