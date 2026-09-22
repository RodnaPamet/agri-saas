-- Offline exactly-once for the two grain write paths the calculator uses.
--
-- Without this a lost response followed by an outbox retry books the same
-- cost or yield twice. Both are financial records, so the duplicate is silent
-- and changes net worth rather than erroring.
--
-- Purely additive: a nullable column plus a unique index over (tenantId,
-- clientMutationId). Every NULL is distinct in Postgres, so existing rows and
-- ordinary online writes are unconstrained. The previous image keeps working
-- against this schema, so no inverse script is required.
ALTER TABLE "CostEntry" ADD COLUMN "clientMutationId" TEXT;
ALTER TABLE "YieldRecord" ADD COLUMN "clientMutationId" TEXT;

CREATE UNIQUE INDEX "CostEntry_tenantId_clientMutationId_key"
    ON "CostEntry"("tenantId", "clientMutationId");
CREATE UNIQUE INDEX "YieldRecord_tenantId_clientMutationId_key"
    ON "YieldRecord"("tenantId", "clientMutationId");
