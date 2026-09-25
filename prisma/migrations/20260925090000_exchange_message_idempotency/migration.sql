-- Exchange messaging — client-supplied idempotency key on a sent message.
--
-- Scoped to the SENDER, not to a tenantId the row does not have. Unique WITH
-- `senderTenantId` so the two parties to a thread may reuse the same
-- client-side id without colliding.
--
-- NULL is unconstrained in Postgres (every NULL is distinct), so existing rows
-- and callers that send no key are unaffected and the index needs no backfill.

ALTER TABLE "ExchangeMessage" ADD COLUMN "clientMutationId" TEXT;

CREATE UNIQUE INDEX "ExchangeMessage_senderTenantId_clientMutationId_key"
    ON "ExchangeMessage"("senderTenantId", "clientMutationId");
