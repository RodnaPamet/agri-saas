-- P5.6b (#1597) — the deletion request, its grace period, and the erasure mark.
--
-- Additive only: two nullable columns and two partial indexes.
--
-- `deletionRequestedAt` is SEPARATE from `suspendedAt` (P5.9) although both
-- withhold something. The cause differs and so does the remedy: a suspension is
-- imposed by a moderator and only a moderator lifts it, while a deletion
-- request is self-inflicted and self-cancellable. Collapsing them would send an
-- Art 17 statement of reasons to somebody who asked to leave, and would let a
-- person cancel their own suspension.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deletionRequestedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "pseudonymisedAt"     TIMESTAMP(3);

-- PARTIAL, like `User_suspendedAt_idx`. The sweep's query is
-- `WHERE "deletionRequestedAt" < now() - 30 days AND "pseudonymisedAt" IS NULL`,
-- so it only ever wants rows where the first column is SET — a handful, against
-- a table of every user. An index entry per NULL would be the size of the user
-- table and serve nothing.
CREATE INDEX IF NOT EXISTS "User_deletionRequestedAt_idx"
    ON "User"("deletionRequestedAt")
    WHERE "deletionRequestedAt" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "User_pseudonymisedAt_idx"
    ON "User"("pseudonymisedAt")
    WHERE "pseudonymisedAt" IS NOT NULL;
