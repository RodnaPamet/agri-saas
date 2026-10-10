-- P5.1 — Trust & safety models (#1553, expanded from #1196).
--
-- SCHEMA ONLY. P5's standing rule is that tables ship one release before the
-- code that writes them, so nothing reads or writes these yet. The RLS is
-- therefore the only thing standing between a future route and a mistake, and
-- it is written now rather than with the first writer.
--
-- Purely additive: four tables, five enums, no column dropped and no data
-- rewritten. That is why there is no `.down.sql` —
-- `destructive-migration-has-inverse` derives the requirement from the
-- statements rather than being told, and finds nothing destructive here.
--
-- Idempotent and safe to re-run throughout: `IF NOT EXISTS` on every create,
-- `DROP POLICY IF EXISTS` before every policy.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THE THREE MODERATION TABLES DENY `app_user` OUTRIGHT
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Moderation is a PLATFORM function. Every role in the enum is tenant-scoped,
-- so a tenant permission such as `admin.manage` would let an ADMIN of any one
-- farm read every other farm's reports. The feature-flag console already
-- reasons this way: "`FeatureFlag` has no `tenantId`, so `admin.manage` would
-- let an ADMIN of any one tenant launch a feature for every other."
--
-- `ALTER DEFAULT PRIVILEGES` (migration 20260323180000) grants app_user
-- SELECT/INSERT/UPDATE/DELETE on every new table in `public` automatically, so
-- these tables ARE grantable to app_user the moment they exist. RLS is what
-- actually refuses, which is why FORCE is set and why the absence of a
-- permissive policy per command is the deny — not an oversight.
--
-- `ContentReport` is the one exception, and it is a deliberate fourth arm:
-- see below.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── enums ───────────────────────────────────────────────────────────────────
-- `CREATE TYPE` has no `IF NOT EXISTS`, so each is guarded.

DO $$ BEGIN
    CREATE TYPE "ReportSubjectKind" AS ENUM ('LISTING', 'MESSAGE', 'PROFILE', 'THREAD');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE "ReportReasonCode" AS ENUM (
        'ILLEGAL_CONTENT', 'SCAM_OR_FRAUD', 'SPAM', 'HARASSMENT_OR_HATE',
        'MISLEADING_LISTING', 'INTELLECTUAL_PROPERTY', 'PERSONAL_DATA', 'OTHER'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE "ReportStatus" AS ENUM ('RECEIVED', 'TRIAGED', 'ACTIONED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE "ModerationActionKind" AS ENUM (
        'NONE', 'CONTENT_REMOVED', 'CONTENT_DEMOTED',
        'ACCOUNT_SUSPENDED', 'ACCOUNT_TERMINATED'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── ContentReport ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "ContentReport" (
    "id"             TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- NULL for an anonymous Art 16 notice. No IP, no hash of one, no
    -- surrogate (#1553 DECISION 5, owner-confirmed): adding a column later is
    -- a migration, but having collected identifiers you did not need is not
    -- undoable.
    "reporterUserId" TEXT,
    "subjectKind"    "ReportSubjectKind" NOT NULL,
    "subjectId"      TEXT NOT NULL,
    "reasonCode"     "ReportReasonCode" NOT NULL,
    -- ENCRYPTED at the application layer (ENCRYPTED_FIELDS).
    "detail"         TEXT,
    "status"         "ReportStatus" NOT NULL DEFAULT 'RECEIVED',

    CONSTRAINT "ContentReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ContentReport_subjectKind_subjectId_idx"
    ON "ContentReport"("subjectKind", "subjectId");
CREATE INDEX IF NOT EXISTS "ContentReport_status_createdAt_idx"
    ON "ContentReport"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "ContentReport_reporterUserId_idx"
    ON "ContentReport"("reporterUserId");

ALTER TABLE "ContentReport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContentReport" FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS content_report_reporter_read ON "ContentReport";
DROP POLICY IF EXISTS superuser_bypass             ON "ContentReport";

-- The FOURTH policy arm (#1553 DECISION 3, owner decision 2026-10-10).
--
-- Without it a reporter cannot read their own notice back, and "my reports" is
-- impossible without a second read path. With it, it is one index lookup.
--
-- `app.user_id` and NOT `app.actor_user_id`. The two are different variables
-- set by different runners, and picking the wrong one here would be silent:
--   * `app.user_id`       — set by `runInUserContext`, person-scoped, NO tenant.
--   * `app.actor_user_id` — set by `runInTenantContext` alongside a tenant.
-- A report has no `tenantId` and a reporter is a person, so the person-scoped
-- runner is the one a "my reports" surface will use. Under a TENANT context
-- `app.user_id` is unset, `current_setting(..., true)` yields NULL, and this
-- arm matches nothing — fail-closed, which is the right direction.
--
-- SELECT only. There is deliberately no INSERT arm for app_user: an Art 16
-- notice is submitted through the platform surface (P5.2), which validates and
-- sanitises it. A reporter who could INSERT directly could forge
-- `reporterUserId`, and `WITH CHECK` on a self-named insert would still let
-- them write any `status` they liked.
--
-- WHY THIS IS SAFE, and why it would NOT have been on a merged table:
-- Postgres RLS is ROW-level, not column-level, so this exposes EVERY column of
-- the reporter's own row. It is acceptable only because the moderation
-- internals live on the other two tables. Anything added to `ContentReport`
-- later is, by construction, reporter-visible.
--
-- Anonymous rows fail closed with no special case: `NULL = NULL` is NULL in
-- SQL, not true, so a row with no reporter matches no reporter — including a
-- session whose own `app.user_id` happens to be unset.
CREATE POLICY content_report_reporter_read ON "ContentReport"
    FOR SELECT
    USING ("reporterUserId" = current_setting('app.user_id', true)::text);

CREATE POLICY superuser_bypass ON "ContentReport"
    USING (current_setting('role') != 'app_user');

-- ─── ModerationAction ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "ModerationAction" (
    "id"           TEXT NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Nullable: a PROACTIVE action has no notice behind it.
    "reportId"     TEXT,
    -- Opaque, NOT a userId (#1553 DECISION 7). A platform moderator's
    -- credential is an API key, so there is no `User` in scope to name.
    "moderatorRef" TEXT NOT NULL,
    "actionKind"   "ModerationActionKind" NOT NULL,
    "subjectKind"  "ReportSubjectKind" NOT NULL,
    "subjectId"    TEXT NOT NULL,
    -- ENCRYPTED at the application layer.
    "rationale"    TEXT NOT NULL,

    CONSTRAINT "ModerationAction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ModerationAction_reportId_idx"
    ON "ModerationAction"("reportId");
CREATE INDEX IF NOT EXISTS "ModerationAction_subjectKind_subjectId_idx"
    ON "ModerationAction"("subjectKind", "subjectId");
CREATE INDEX IF NOT EXISTS "ModerationAction_createdAt_idx"
    ON "ModerationAction"("createdAt");

ALTER TABLE "ModerationAction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ModerationAction" FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS superuser_bypass ON "ModerationAction";

-- Platform-only. `superuser_bypass` is the ONLY policy, and for an app_user
-- session its predicate is false, so every command sees zero rows and a write
-- is refused. There is no permissive arm to widen by accident.
CREATE POLICY superuser_bypass ON "ModerationAction"
    USING (current_setting('role') != 'app_user');

-- ─── StatementOfReasons ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "StatementOfReasons" (
    "id"              TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actionId"        TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    -- Resolved at SEND time: the locale actually used, not the one the
    -- recipient has today.
    "locale"          TEXT NOT NULL,
    -- ENCRYPTED. Stored RENDERED, per the NotificationOutbox precedent — what
    -- was sent is a fact, and re-rendering from a since-changed template would
    -- answer a different question.
    "bodyRendered"    TEXT NOT NULL,
    -- NULL until the push succeeds. The gap from `createdAt` is the Art 17
    -- delivery lag.
    "deliveredAt"     TIMESTAMP(3),

    CONSTRAINT "StatementOfReasons_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "StatementOfReasons_actionId_idx"
    ON "StatementOfReasons"("actionId");
CREATE INDEX IF NOT EXISTS "StatementOfReasons_recipientUserId_idx"
    ON "StatementOfReasons"("recipientUserId");
CREATE INDEX IF NOT EXISTS "StatementOfReasons_deliveredAt_idx"
    ON "StatementOfReasons"("deliveredAt");

ALTER TABLE "StatementOfReasons" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StatementOfReasons" FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS superuser_bypass ON "StatementOfReasons";

-- Platform-only, and NOT recipient-readable. DSA Art 17 gives the recipient a
-- right to the statement, which is satisfied by DELIVERY (email /
-- notification, in the recipient's language per P5.4) rather than by read
-- access to this row. A recipient arm here would also be row-level and would
-- expose `actionId`, which links to the moderation rationale.
CREATE POLICY superuser_bypass ON "StatementOfReasons"
    USING (current_setting('role') != 'app_user');

-- ─── UserBlock ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "UserBlock" (
    "id"            TEXT NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "blockerUserId" TEXT NOT NULL,
    "blockedUserId" TEXT NOT NULL,

    CONSTRAINT "UserBlock_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UserBlock_blockerUserId_blockedUserId_key"
    ON "UserBlock"("blockerUserId", "blockedUserId");
CREATE INDEX IF NOT EXISTS "UserBlock_blockedUserId_idx"
    ON "UserBlock"("blockedUserId");

ALTER TABLE "UserBlock" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserBlock" FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_block_select ON "UserBlock";
DROP POLICY IF EXISTS user_block_insert ON "UserBlock";
DROP POLICY IF EXISTS user_block_update ON "UserBlock";
DROP POLICY IF EXISTS user_block_delete ON "UserBlock";
DROP POLICY IF EXISTS superuser_bypass  ON "UserBlock";

-- SPLIT per command, following `ExchangeBlock` and NOT `UserSession`
-- (#1553 DECISION 1).
--
-- SELECT is the wide arm: the block is ENFORCED while running in the BLOCKED
-- person's context — their own send is what must be refused — so a row they
-- cannot see cannot refuse them.
--
-- The other three arms name the BLOCKER only. A single `USING` clause covering
-- every command would have governed DELETE too, and let the blocked person
-- unblock themselves. That is the whole reason for the split.
--
-- This is deliberately the OPPOSITE of `UserSession`'s one-policy rule, whose
-- migration forbids splitting because "a permissive policy with no WITH CHECK
-- implicitly grants WITH CHECK (true) on UPDATE for visible rows", which would
-- let a session rewrite its own `tenantId`. This table has no `tenantId` to
-- rewrite, so that threat does not apply and the DELETE threat does. The
-- UPDATE arm below still carries an explicit `WITH CHECK` so the implicit
-- grant cannot arise.
--
-- `app.user_id`, not `app.actor_user_id` — a person↔person block is read and
-- written in a PERSON context (`runInUserContext`). Under a tenant context the
-- variable is unset and every arm matches nothing: fail-closed, and for a
-- block that means it stops refusing rather than erroring, which is why
-- `tests/integration/p5-1-trust-safety-rls.test.ts` asserts a NON-ZERO count
-- on the blocked party's read.
CREATE POLICY user_block_select ON "UserBlock"
    FOR SELECT
    USING (
        "blockerUserId" = current_setting('app.user_id', true)::text
        OR "blockedUserId" = current_setting('app.user_id', true)::text
    );

CREATE POLICY user_block_insert ON "UserBlock"
    FOR INSERT
    WITH CHECK ("blockerUserId" = current_setting('app.user_id', true)::text);

CREATE POLICY user_block_update ON "UserBlock"
    FOR UPDATE
    USING ("blockerUserId" = current_setting('app.user_id', true)::text)
    WITH CHECK ("blockerUserId" = current_setting('app.user_id', true)::text);

CREATE POLICY user_block_delete ON "UserBlock"
    FOR DELETE
    USING ("blockerUserId" = current_setting('app.user_id', true)::text);

CREATE POLICY superuser_bypass ON "UserBlock"
    USING (current_setting('role') != 'app_user');
