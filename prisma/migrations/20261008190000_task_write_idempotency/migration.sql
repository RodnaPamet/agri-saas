-- Offline exactly-once for the two task-side writes the field app makes:
-- a comment on a task, and a weed observation filed while closing one.
--
-- Without this, a lost response followed by an outbox retry posts the comment
-- twice, or files the same weeds twice against the same parcel. The weed row
-- is worse than untidy: observations feed the ДНЕВНИК record, so a duplicate
-- misstates what was actually seen in the field on that date.
--
-- Purely additive: a nullable column plus a unique index over (tenantId,
-- clientMutationId). Every NULL is distinct in Postgres, so existing rows and
-- ordinary online writes are unconstrained — no backfill, and no inverse
-- script, because the previous image keeps working against this schema.
--
-- A PARTIAL index (`WHERE clientMutationId IS NOT NULL`) would behave
-- identically for deduplication and is NOT used here: NULLS-DISTINCT already
-- exempts keyless rows, so the WHERE would only trade index size for a
-- divergence from the four models that already carry this exact pair
-- (Task, CostEntry, YieldRecord, ExchangeMessage). Matching them keeps one
-- shape for the whole offline-write surface.
ALTER TABLE "TaskComment" ADD COLUMN "clientMutationId" TEXT;
ALTER TABLE "ParcelWeedObservation" ADD COLUMN "clientMutationId" TEXT;

CREATE UNIQUE INDEX "TaskComment_tenantId_clientMutationId_key"
    ON "TaskComment"("tenantId", "clientMutationId");
CREATE UNIQUE INDEX "ParcelWeedObservation_tenantId_clientMutationId_key"
    ON "ParcelWeedObservation"("tenantId", "clientMutationId");
