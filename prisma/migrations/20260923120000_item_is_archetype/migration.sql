-- Mark seeded illustrative products, so a spray cannot be filed against one (#1078).
--
-- Additive, defaulting to false: an unmarked row is treated as a REAL product,
-- which is the safe direction. The flag gates a refusal, so a false positive
-- would block an operator from recording work they actually did — worse than a
-- false negative, which merely lets through the status quo.
ALTER TABLE "Item" ADD COLUMN "isArchetype" BOOLEAN NOT NULL DEFAULT false;

-- Backfill requires ALL THREE independent signals to agree. Each alone is a
-- perfect discriminator on today's data (22 archetypes / 2 user-created), and
-- none was DESIGNED as a provenance marker — `attributesJson` is agronomic
-- metadata archetypes happen to carry, `createdByUserId` is nullable for any
-- system context, and the name prefix is a string heuristic. Requiring the
-- conjunction makes a mistaken mark need three coincidences instead of one.
UPDATE "Item"
SET "isArchetype" = true
WHERE "attributesJson" IS NOT NULL
  AND "createdByUserId" IS NULL
  AND "name" LIKE 'Generic %';
