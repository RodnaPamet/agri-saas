-- P5.2 — the evidence a notice is about (#1593), owner decision on #1553
-- DECISION 4.
--
-- Purely additive: one table, no column dropped, no data rewritten. No
-- `.down.sql` — `destructive-migration-has-inverse` derives that from the
-- statements rather than being told.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY A TABLE AND NOT A COLUMN ON `ContentReport`
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The decision was "snapshot column", and the substance of it is honoured:
-- evidence is captured server-side at report time, because content removed
-- before a moderator looks is the normal case for a notice about something
-- real, and Art 16 still requires an answer.
--
-- What changed is WHERE, and the reason is one line of Postgres semantics:
-- `content_report_reporter_read` is ROW-level, so every column on
-- `ContentReport` is reporter-readable. A snapshot column would therefore hand
-- a reporter a durable, decryptable copy of a private message AFTER its author
-- deleted it. That is retention, not a receipt.
--
-- So this table denies `app_user` outright, exactly as `ModerationAction` and
-- `StatementOfReasons` do, and for the same reason: content a reporter must not
-- retain does not live where the reporter arm can reach it.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "ReportSnapshot" (
    "id"           TEXT NOT NULL,
    -- When the CONTENT was captured, not when the notice was filed.
    "capturedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Not an FK: a snapshot must outlive the pseudonymisation of its reporter
    -- (P5.6), and a Cascade would delete the evidence of a resolved case along
    -- with the person who reported it.
    "reportId"     TEXT NOT NULL,
    -- Denormalised on purpose: a snapshot has to be interpretable without a
    -- join, and the pair is what makes the subject index useful.
    "subjectKind"  "ReportSubjectKind" NOT NULL,
    "subjectId"    TEXT NOT NULL,
    -- ENCRYPTED at the application layer (ENCRYPTED_FIELDS + GLOBAL_KEK_MODELS).
    "body"         TEXT NOT NULL,
    -- NULL when capture succeeded; the REASON when it did not, because a notice
    -- with missing evidence still has to be answered and the answer differs by
    -- cause.
    "captureError" TEXT,

    CONSTRAINT "ReportSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ReportSnapshot_reportId_idx"
    ON "ReportSnapshot"("reportId");
CREATE INDEX IF NOT EXISTS "ReportSnapshot_subjectKind_subjectId_idx"
    ON "ReportSnapshot"("subjectKind", "subjectId");
CREATE INDEX IF NOT EXISTS "ReportSnapshot_capturedAt_idx"
    ON "ReportSnapshot"("capturedAt");

ALTER TABLE "ReportSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReportSnapshot" FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS superuser_bypass ON "ReportSnapshot";

-- Platform-only. `superuser_bypass` is the ONLY policy: for an `app_user`
-- session its predicate is false, so every command sees zero rows and a write
-- is refused. There is no permissive arm to widen by accident, and
-- `rls-coverage`'s PLATFORM_ONLY_RLS_MODELS asserts the policy set by EQUALITY
-- so adding one fails rather than passing.
--
-- This matters more than for the other three, because the write path for this
-- table runs while serving a REPORTER's request — so the temptation to give
-- `app_user` an insert arm is real. It must not have one: the capture happens
-- on the privileged path, as the moderation write does.
CREATE POLICY superuser_bypass ON "ReportSnapshot"
    USING (current_setting('role') != 'app_user');
