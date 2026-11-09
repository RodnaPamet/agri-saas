-- Remove `CONTENT_DEMOTED` from `ModerationActionKind` — #2868, owner decision
-- 2026-11-09.
--
-- There is no ranking in this product to demote within, so the value announced
-- a sanction that does not exist. #2865 made `actOnNotice` refuse it; this is
-- the deletion that refusal was holding the place for.
--
-- Postgres cannot drop a value from an enum, so the type is RECREATED. One
-- column uses it (`ModerationAction.actionKind`) and the USING cast goes via
-- `text`, which is what makes the rewrite safe: any row still holding the
-- dropped value would fail the cast and abort the transaction rather than
-- silently becoming something else. Measured on production before writing
-- this: `ModerationAction` holds 0 rows and `StatementOfReasons` 0, so the
-- cast rewrites nothing.
--
-- `CONTENT_RESTORED` is KEPT. It is written by the restore route (#2867) and
-- is deliberately not acceptable as an input on a notice, so it is absent from
-- `MODERATION_ACTION_KINDS` while remaining a real stored value.
BEGIN;

ALTER TYPE "ModerationActionKind" RENAME TO "ModerationActionKind_old";

CREATE TYPE "ModerationActionKind" AS ENUM (
    'NONE',
    'CONTENT_REMOVED',
    'ACCOUNT_SUSPENDED',
    'ACCOUNT_TERMINATED',
    'CONTENT_RESTORED'
);

ALTER TABLE "ModerationAction"
    ALTER COLUMN "actionKind" TYPE "ModerationActionKind"
    USING ("actionKind"::text::"ModerationActionKind");

DROP TYPE "ModerationActionKind_old";

COMMIT;
