-- #1655 — a deletion-pending seller's listings are withheld from other farms
-- for the 30-day grace period, and restored verbatim if they cancel.
--
-- Additive and nullable, so the previous image reads and writes the table
-- unchanged and no rollback script is required (see deploy/rollback/README.md:
-- an inverse is needed for a rename, a drop, or a rewrite of persisted data).
ALTER TABLE "ExchangeListing"
    ADD COLUMN IF NOT EXISTS "suppressedForDeletionAt" TIMESTAMP(3);

-- PARTIAL, and on the suppressed rows rather than the visible ones.
--
-- The cross-farm browse query gains `"suppressedForDeletionAt" IS NULL`, which
-- is true of virtually every row — an index over that predicate would be the
-- whole table and would not be chosen. What needs to be fast is the OTHER
-- direction: the restore on cancel, which looks up exactly this person's
-- suppressed rows. That set is tiny and this index covers it.
CREATE INDEX IF NOT EXISTS "ExchangeListing_suppressedForDeletion_idx"
    ON "ExchangeListing" ("sellerUserId")
    WHERE "suppressedForDeletionAt" IS NOT NULL;
