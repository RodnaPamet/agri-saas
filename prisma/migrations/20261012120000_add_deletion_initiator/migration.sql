-- #1671 — who asked for an account's erasure.
--
-- Additive: a new enum type and a NULLABLE column. No rollback inverse is
-- required (see deploy/rollback/README.md): nothing is renamed, dropped or
-- rewritten, so the previous image keeps working against this schema — it
-- simply never reads or writes the column.
--
-- NULL reads as SELF in application code. Termination -> erasure only shipped
-- in #1654 and production holds no terminated accounts, so every pre-existing
-- row is a self-service request.
CREATE TYPE "DeletionInitiator" AS ENUM ('SELF', 'MODERATION');

ALTER TABLE "User" ADD COLUMN "deletionRequestedBy" "DeletionInitiator";
