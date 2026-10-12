-- #1667 — when a moderator TERMINATED the account.
--
-- Additive: one nullable column. No rollback inverse required (see
-- deploy/rollback/README.md) — nothing renamed, dropped or rewritten, and the
-- previous image keeps working because it never reads or writes it.
--
-- NULL means "not terminated". Production holds no terminated accounts
-- (termination -> erasure only shipped in #1654), so no backfill is needed and
-- there is no row for which NULL is the wrong answer.
ALTER TABLE "User" ADD COLUMN "terminatedAt" TIMESTAMP(3);
