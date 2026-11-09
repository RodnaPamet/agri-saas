-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK — undo `20261109100000_drop_content_demoted`
-- ═══════════════════════════════════════════════════════════════════════
--
-- WHY THIS FILE EXISTS
--
-- Pinning Watchtower to the previous image does NOT undo a migration. The
-- image immediately before this one has `CONTENT_DEMOTED` in its generated
-- Prisma client's `ModerationActionKind`, and Prisma validates an enum value
-- against the type it finds in the database. With the value gone from the
-- type, that image's `actOnNotice` still accepts `CONTENT_DEMOTED` through
-- `MODERATION_ACTION_KINDS` and its `assertPerformable` refuses it before any
-- write — so the forward direction degrades gracefully for THAT path.
--
-- What does not degrade is the enum round-trip. The previous client builds its
-- own enum object from the schema it was generated against, and any read that
-- deserialises `actionKind` into it is working from a list with a value the
-- database no longer declares. Restoring the type is cheap and removes the
-- question entirely.
--
-- ── WHAT THIS RESTORES, AND WHAT IT DOES NOT ─────────────────────────
--
-- RESTORES: the value, in its original ORDINAL POSITION (third, between
-- `CONTENT_REMOVED` and `ACCOUNT_SUSPENDED`). Position matters because Prisma
-- compares the enum as an ordered list when it diffs the schema, so appending
-- it would leave `prisma migrate diff` reporting a difference for ever.
--
-- DOES NOT RESTORE: any row that held the value. There were none — production
-- held 0 `ModerationAction` rows when the forward migration ran, which is
-- what made the deletion safe — so there is nothing to bring back. If this is
-- ever run against a database that DID hold such rows, the forward migration
-- would have aborted on the cast and never committed, so the value is still
-- there and this script is not needed.
--
-- ── RUNNING IT ───────────────────────────────────────────────────────
--
-- One transaction, and it deletes its own `_prisma_migrations` row so a later
-- roll-forward RE-APPLIES rather than silently skipping (the convention every
-- script in this directory follows — `prisma migrate deploy` keys on the
-- migration name, not on the state of the objects).
BEGIN;

ALTER TYPE "ModerationActionKind" RENAME TO "ModerationActionKind_new";

CREATE TYPE "ModerationActionKind" AS ENUM (
    'NONE',
    'CONTENT_REMOVED',
    'CONTENT_DEMOTED',
    'ACCOUNT_SUSPENDED',
    'ACCOUNT_TERMINATED',
    'CONTENT_RESTORED'
);

ALTER TABLE "ModerationAction"
    ALTER COLUMN "actionKind" TYPE "ModerationActionKind"
    USING ("actionKind"::text::"ModerationActionKind");

DROP TYPE "ModerationActionKind_new";

DELETE FROM "_prisma_migrations"
WHERE "migration_name" = '20261109100000_drop_content_demoted';

COMMIT;
