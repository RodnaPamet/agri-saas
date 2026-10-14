-- The key the ДНЕВНИК list folds on (#1740).
--
-- Added nullable, backfilled, THEN made NOT NULL — in that order, because the
-- column must never be null even for rows that predate it. `DISTINCT ON`
-- treats all NULLs as one value, so a single null-bearing row set would
-- collapse every manual entry a farm has written into one row.
--
-- Backfilled with the entry's OWN id: an entry belonging to no treatment
-- folds to itself, which is what makes the one-list-with-both-kinds behaviour
-- fall out of the same mechanism instead of needing a second code path.
-- Deterministic, and self-documenting in the data.
--
-- No DB-side DEFAULT: Prisma's `@default(uuid())` is generated client-side,
-- so new rows arrive with a value already set.
ALTER TABLE "LogEntry" ADD COLUMN "treatmentGroupId" TEXT;

UPDATE "LogEntry" SET "treatmentGroupId" = "id" WHERE "treatmentGroupId" IS NULL;

ALTER TABLE "LogEntry" ALTER COLUMN "treatmentGroupId" SET NOT NULL;

CREATE INDEX "LogEntry_tenantId_treatmentGroupId_idx"
    ON "LogEntry"("tenantId", "treatmentGroupId");
