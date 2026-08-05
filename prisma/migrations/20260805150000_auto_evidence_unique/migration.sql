-- One auto-evidence row per (farm record, control).
--
-- `attachAutoEvidenceFromLogEntry` guarded idempotency with a read-then-write
-- check: SELECT the controls already carrying evidence for this LogEntry, then
-- INSERT for the rest. That is TOCTOU. The job runs inside a transaction
-- opened by a journal write, so a retry or a concurrent field-operation save
-- could have two callers each read "not attached" and each insert — one
-- control point apparently backed by two copies of the same record, and a
-- duplicate row a reviewer has to approve twice.
--
-- NULLs do not collide under a Postgres unique index, so hand-filed evidence
-- (sourceLogEntryId IS NULL) is entirely unaffected by this constraint.

-- Collapse any duplicates that already exist before the index is built.
-- Keep the oldest row of each group: it is the one whose id the audit trail
-- and any ControlEvidenceLink already reference.
WITH ranked AS (
    SELECT "id",
           row_number() OVER (
               PARTITION BY "tenantId", "sourceLogEntryId", "controlId"
               ORDER BY "createdAt" ASC, "id" ASC
           ) AS rn
    FROM "Evidence"
    WHERE "sourceLogEntryId" IS NOT NULL
      AND "controlId" IS NOT NULL
)
DELETE FROM "Evidence"
WHERE "id" IN (SELECT "id" FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX "Evidence_tenantId_sourceLogEntryId_controlId_key"
    ON "Evidence" ("tenantId", "sourceLogEntryId", "controlId");
