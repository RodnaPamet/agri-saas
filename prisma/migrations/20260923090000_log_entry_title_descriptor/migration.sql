-- Descriptor for a server-composed journal title (#1073).
--
-- Purely additive: `title` keeps its NOT NULL and every existing consumer
-- keeps reading it. `titleKey` non-null marks the title as a RENDERING that a
-- reader may re-resolve in its own language; null means a person wrote it.
--
-- No backfill here. The 9 existing English rows are rewritten by
-- `scripts/backfill-journal-title-descriptors.ts`, which records prior values
-- so the change is reversible -- a migration that silently rewrote rows of a
-- legally-filed register would not be.
ALTER TABLE "LogEntry" ADD COLUMN "titleKey" TEXT;
ALTER TABLE "LogEntry" ADD COLUMN "titleParams" JSONB;
