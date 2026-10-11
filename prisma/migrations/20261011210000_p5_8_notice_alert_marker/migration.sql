-- P5.8 (#1599) — the marker that a human has been told about a notice.
--
-- Additive: one nullable column and one partial index.
--
-- NULL means nobody has been alerted, and that absence IS the queue — the same
-- shape as `StatementOfReasons.deliveredAt` and `NoticeScore`, and for the same
-- reason: a flag somebody has to maintain is a flag somebody forgets, while an
-- absent marker cannot drift out of step with what was actually sent.
--
-- Reporter-visible, like every column on this table (the
-- `content_report_reporter_read` arm is ROW-level), and that is acceptable on
-- its own terms: it says somebody was notified, which is reassurance rather
-- than disclosure. `content-report-columns-are-reporter-safe` carries the
-- written note.
ALTER TABLE "ContentReport" ADD COLUMN IF NOT EXISTS "alertedAt" TIMESTAMP(3);

-- PARTIAL on the un-alerted set.
--
-- The query is `WHERE "alertedAt" IS NULL ORDER BY "createdAt" ASC LIMIT n`,
-- and an alerted notice is never selected again — so the index wants the rows
-- that are still waiting, not one entry per notice ever filed. On a table that
-- grows with every report and whose queue is almost always empty, the
-- difference is the whole index.
CREATE INDEX IF NOT EXISTS "ContentReport_alertedAt_createdAt_idx"
    ON "ContentReport"("createdAt")
    WHERE "alertedAt" IS NULL;
