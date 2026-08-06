-- Calendar agriculture-sources PR — index the date predicates that were
-- never indexed.
--
-- `getComplianceCalendarEvents` (src/app-layer/usecases/compliance-calendar.ts)
-- fans out across every date-bearing entity on every calendar load. This PR
-- grew that fan-out from 12 to 17 sources; four of the pre-existing loaders
-- were filtering on date columns with NO index behind them at all, so every
-- calendar view was a per-tenant sequential scan of these tables:
--
--   Evidence(nextReviewDate)              — loadEvidenceEvents
--   AuditCycle(periodStartAt, periodEndAt) — loadAuditCycleEvents
--   Risk(nextReviewAt, targetDate)         — loadRiskEvents
--   Finding(dueDate)                       — loadFindingEvents
--
-- Every index below leads with `tenantId` — the repo convention, because
-- every query in this codebase filters by tenant first (RLS + the
-- app-layer tenantId predicate both key on it). AuditCycle and Risk each
-- get TWO separate composites rather than one multi-column index: their
-- loaders `OR` two independent date columns together, so a single
-- `(tenantId, colA, colB)` index would only ever serve the leading column
-- — Postgres can't use the same index to satisfy an OR across both.
--
-- IF NOT EXISTS keeps this idempotent on a drifted DB.

CREATE INDEX IF NOT EXISTS "Evidence_tenantId_nextReviewDate_idx"
    ON "Evidence" ("tenantId", "nextReviewDate");

CREATE INDEX IF NOT EXISTS "AuditCycle_tenantId_periodStartAt_idx"
    ON "AuditCycle" ("tenantId", "periodStartAt");

CREATE INDEX IF NOT EXISTS "AuditCycle_tenantId_periodEndAt_idx"
    ON "AuditCycle" ("tenantId", "periodEndAt");

CREATE INDEX IF NOT EXISTS "Risk_tenantId_nextReviewAt_idx"
    ON "Risk" ("tenantId", "nextReviewAt");

CREATE INDEX IF NOT EXISTS "Risk_tenantId_targetDate_idx"
    ON "Risk" ("tenantId", "targetDate");

CREATE INDEX IF NOT EXISTS "Finding_tenantId_dueDate_idx"
    ON "Finding" ("tenantId", "dueDate");
