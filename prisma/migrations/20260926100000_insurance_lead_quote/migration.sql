-- Additive only: two nullable columns and one unique index.
--
-- Postgres treats NULLs as DISTINCT in a unique index, so every existing row
-- (clientMutationId NULL) and every future keyless lead coexist without a
-- backfill and without collisions.
ALTER TABLE "InsuranceLead" ADD COLUMN "quoteJson" JSONB;
ALTER TABLE "InsuranceLead" ADD COLUMN "clientMutationId" TEXT;

CREATE UNIQUE INDEX "InsuranceLead_inquirerTenantId_clientMutationId_key"
    ON "InsuranceLead" ("inquirerTenantId", "clientMutationId");
