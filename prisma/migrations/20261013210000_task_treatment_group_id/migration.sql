-- #1740 — one handle per treatment, across the per-block tasks it became.
--
-- Additive, and no rollback inverse is required (deploy/rollback/README.md):
-- nothing is renamed, dropped or narrowed, and the previous image neither
-- reads nor writes this column.
--
-- Nullable rather than NOT NULL DEFAULT '': there is no sensible empty
-- handle, and null means "not part of a diary treatment", which is every
-- task that exists today. A defaulted empty string would make every legacy
-- task a member of one enormous group.
ALTER TABLE "Task"
    ADD COLUMN "treatmentGroupId" TEXT;

-- Partial index on the non-null rows only.
--
-- The lookup is "give me the tasks of this treatment", so only rows that
-- belong to one are ever matched. Task is among the busiest tables in the
-- schema and the overwhelming majority of its rows will carry null here, so
-- a full index would be mostly dead weight that every insert still pays for.
CREATE INDEX "Task_tenantId_treatmentGroupId_idx"
    ON "Task" ("tenantId", "treatmentGroupId")
    WHERE "treatmentGroupId" IS NOT NULL;
