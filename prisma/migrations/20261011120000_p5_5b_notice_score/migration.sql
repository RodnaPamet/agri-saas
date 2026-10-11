-- P5.5b (#1596) — the AI's shadow score for a notice.
--
-- PLATFORM-ONLY. `superuser_bypass` is the ONLY policy: for an `app_user`
-- session its predicate is false, so every command sees zero rows and every
-- write is refused. There is no permissive arm to widen by accident, and
-- `rls-coverage`'s PLATFORM_ONLY_RLS_MODELS asserts the policy set by EQUALITY
-- so adding one fails rather than passing.
--
-- RLS is the only refusal that matters, because migration 20260323180000's
-- `ALTER DEFAULT PRIVILEGES` grants `app_user` SELECT/INSERT/UPDATE/DELETE on
-- every new table in `public` — a tenantless table is reachable the moment it
-- exists.
--
-- Why not a column on `ContentReport`: that table carries
-- `content_report_reporter_read`, a row-level SELECT arm keyed on
-- `app.user_id`. Postgres RLS is ROW-level, not column-level, so every column
-- on `ContentReport` is readable by the reporter — and a score there would be
-- readable by the person it was computed about. `ReportSnapshot` exists for the
-- same reason.
CREATE TABLE IF NOT EXISTS "NoticeScore" (
    "id"        TEXT NOT NULL,
    "reportId"  TEXT NOT NULL,
    "score"     INTEGER NOT NULL,
    "rationale" TEXT NOT NULL,
    "model"     TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NoticeScore_pkey" PRIMARY KEY ("id")
);

-- One score per notice. This is what makes the scorer idempotent without a
-- flag: a second attempt on the same notice violates the constraint rather
-- than quietly spending the platform AI budget twice.
CREATE UNIQUE INDEX IF NOT EXISTS "NoticeScore_reportId_key"
    ON "NoticeScore"("reportId");
CREATE INDEX IF NOT EXISTS "NoticeScore_createdAt_idx"
    ON "NoticeScore"("createdAt");

ALTER TABLE "NoticeScore" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NoticeScore" FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS superuser_bypass ON "NoticeScore";

CREATE POLICY superuser_bypass ON "NoticeScore"
    USING (current_setting('role') != 'app_user');

-- Note what this gives shadow mode at the DATABASE level: no arm grants
-- `app_user` any access to `score`, so even if application code were changed
-- to read it on a request path, a tenant session would see zero rows. The
-- guard `notice-score-is-shadow-only` is the source half of the same control;
-- neither subsumes the other.
