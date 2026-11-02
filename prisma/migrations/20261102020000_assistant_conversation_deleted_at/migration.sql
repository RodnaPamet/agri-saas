-- The person deletes an exchange (#2695).
--
-- ADDITIVE: a nullable column and an index, so the previous image keeps
-- working and no `deploy/rollback/` inverse is required.
--
-- A SEPARATE migration from `20261101210000_assistant_conversation_extracted_at`
-- rather than an edit to it. That file is already applied somewhere, and
-- Prisma records a migration by NAME: appending to an applied file means the
-- appended statement never runs, silently, on every database that applied the
-- earlier version. Learned the hard way on that very file.
ALTER TABLE "AssistantConversation" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- The conversation LIST: one person's exchanges across every farm, newest
-- first. `userId` leads because the owner's scope is "all sessions with a
-- user" — the farm is the narrower case, so a tenantId-leading index cannot
-- serve this read.
CREATE INDEX "AssistantConversation_userId_deletedAt_lastTurnAt_idx"
    ON "AssistantConversation" ("userId", "deletedAt", "lastTurnAt");
