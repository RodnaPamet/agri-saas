-- #1667 — ACCOUNT as the subject of a moderation ACTION.
--
-- Additive: a new enum VALUE. No rollback inverse is required (see
-- deploy/rollback/README.md) — nothing is renamed, dropped or rewritten, and
-- the previous image keeps working because it never writes the value.
--
-- NOT reportable: `REPORT_SUBJECT_KINDS` (the zod list `FileReportSchema`
-- validates against) stays at four, held as a strict subset by
-- tests/guards/report-subject-kinds-mirror.test.ts.
ALTER TYPE "ReportSubjectKind" ADD VALUE 'ACCOUNT';
