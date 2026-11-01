-- Assistant memory extraction marker (#2671).
--
-- Purely ADDITIVE: a nullable column and an index. The previous image keeps
-- working against this schema, so no `deploy/rollback/` inverse is required —
-- see `tests/guards/destructive-migration-has-inverse.test.ts`, which derives
-- the destructive set from DROP/RENAME statements.
--
-- The index is NOT tenant-leading, unlike every other index on this table. The
-- extraction sweep runs ACROSS tenants — it must find every idle conversation,
-- not one farm's — so a `tenantId`-leading index cannot serve its scan.
-- `extractedAt` leads because `IS NULL` is the selective term: the unextracted
-- set drains to near zero while the table grows.
ALTER TABLE "AssistantConversation" ADD COLUMN "extractedAt" TIMESTAMP(3);

CREATE INDEX "AssistantConversation_extractedAt_lastTurnAt_idx"
    ON "AssistantConversation" ("extractedAt", "lastTurnAt");
