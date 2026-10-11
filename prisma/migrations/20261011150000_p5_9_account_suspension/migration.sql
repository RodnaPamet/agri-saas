-- P5.9 (#1600) — the suspension state that `ACCOUNT_SUSPENDED` never had.
--
-- #1635 is the defect this closes: `ModerationActionKind.ACCOUNT_SUSPENDED` has
-- been a recordable outcome since P5.1 and an announced one since P5.4b — the
-- Art 17 statement tells the recipient "не можете да публикувате или да
-- изпращате съобщения" — while nothing in the schema or the application could
-- withhold anything. The console reported success and the account kept posting.
--
-- Additive only: a nullable column and an index. No `.down.sql` is required by
-- `destructive-migration-has-inverse`, and the previous image tolerates an
-- unknown column, so an image-only rollback is safe here.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "suspendedAt" TIMESTAMP(3);

-- PARTIAL on purpose.
--
-- The index exists for two reads with opposite shapes: the per-request check
-- (`SELECT "suspendedAt" WHERE id = $1`, which the primary key already serves)
-- and the console's "who is currently suspended" (`WHERE "suspendedAt" IS NOT
-- NULL`). Only the second needs an index, and it wants the handful of SET rows
-- rather than an entry per user — so the predicate keeps the index the size of
-- the suspended population instead of the size of the user table.
--
-- Prisma's DSL cannot express a partial index, so `@@index([suspendedAt])` in
-- the schema is the closest declaration and this is the real one. That
-- divergence is the same shape `KnowledgeArticle`'s global-slug unique index
-- carries, and is noted in both places.
CREATE INDEX IF NOT EXISTS "User_suspendedAt_idx"
    ON "User"("suspendedAt")
    WHERE "suspendedAt" IS NOT NULL;

-- ── The platform audit verbs for it ──────────────────────────────────
--
-- `PlatformAuditAction` is a Postgres enum, so adding a value is a migration.
-- Paired on purpose: a suspension history recording only suspensions would show
-- every account as still suspended.
--
-- `ADD VALUE IF NOT EXISTS` is not transactional on older Postgres, which is
-- why these are the last statements in the file — a failure here leaves the
-- column and index above already applied, and re-running is safe.
ALTER TYPE "PlatformAuditAction" ADD VALUE IF NOT EXISTS 'ACCOUNT_SUSPENDED';
ALTER TYPE "PlatformAuditAction" ADD VALUE IF NOT EXISTS 'ACCOUNT_SUSPENSION_LIFTED';
