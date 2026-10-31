-- «Документи» — the idempotency handle for a retried upload (#2495 step 2).
--
-- Owner ruling 2026-10-31: the column lands WITH the routes rather than the
-- routes shipping an `Idempotency-Key` header they cannot honour. That is a
-- deliberate exception to the staging rule step 1 followed ("tables ship one
-- release before the code"), taken because the alternative was a published
-- contract the server ignores — and the iOS client (agrent-ios#468) codes
-- against that contract.
--
-- Purely additive: one nullable column, one unique index. Nothing dropped,
-- nothing rewritten, so the previous image keeps working against this schema
-- and `deploy/rollback/` needs no inverse script.
--
-- WHY A COLUMN AND NOT A CONTENT HASH. Deduping on (tenantId, sha256) needs no
-- migration and was rejected: a farm legitimately uploads the same scan twice —
-- one lease agreement attached to two parcels is the obvious case — so a hash
-- would merge two real documents in order to spare one retry. The failure
-- directions are not symmetric. A duplicate row after a lost response is
-- visible and the farmer deletes one; a silently merged document is a record
-- the farm believes it filed and cannot find.
--
-- NULLS DISTINCT is load-bearing, and it is Postgres's default rather than
-- something this statement asks for: every NULL is unique, so an upload that
-- carries no key is unconstrained and many of them can coexist. Only a client
-- that actually sends a key opts into the constraint. Same shape as
-- `LogEntry.clientMutationId` and `Task.clientMutationId`.
--
-- The pair is (tenantId, clientMutationId) and not the key alone: it is a
-- client's own id, unique within the farm that generated it, and a global
-- constraint would let one farm's retry collide with another's.

ALTER TABLE "FarmDocument" ADD COLUMN IF NOT EXISTS "clientMutationId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "FarmDocument_tenantId_clientMutationId_key"
    ON "FarmDocument" ("tenantId", "clientMutationId");
