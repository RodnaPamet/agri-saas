-- #1740 — a journal entry a person recorded IN the Дневник, which still
-- carries an operation line.
--
-- Additive, and no rollback inverse is required (deploy/rollback/README.md):
-- nothing is renamed, dropped or narrowed, and the previous image keeps
-- working because it never writes or reads this column. An old image's
-- journal list goes on filtering `operationParcelId IS NULL` and simply does
-- not see the new entries, which is the same behaviour it has today.
--
-- DEFAULT false is the load-bearing part. The journal list shows manual
-- entries only (owner ruling 2026-10-10), and it implemented that by reading
-- `operationParcelId IS NULL` as proof a row came from a task. Defaulting to
-- false means every existing row, and everything `recordInputApplication`
-- writes from a completed task line, keeps exactly the visibility it has now.
-- Only a writer that sets this deliberately changes anything.
--
-- NOT NULL with a default rather than nullable: there is no third state. An
-- entry either was recorded in the diary or was not, and a NULL would make
-- every reader decide what absence means.
ALTER TABLE "LogEntry"
    ADD COLUMN "recordedInDiary" BOOLEAN NOT NULL DEFAULT false;

-- Partial index on the TRUE rows only.
--
-- The list query's new shape is `operationParcelId IS NULL OR
-- recordedInDiary`, and the second disjunct selects a small minority of rows
-- — diary-recorded treatments against every task-written application a farm
-- accumulates. A full index on a mostly-false boolean would be read past;
-- a partial index is the subset the query actually needs.
CREATE INDEX "LogEntry_tenantId_recordedInDiary_idx"
    ON "LogEntry" ("tenantId", "occurredAt")
    WHERE "recordedInDiary";
