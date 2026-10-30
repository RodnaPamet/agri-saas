-- «Документи» step 2 — idempotency for the upload route (#2495).
--
-- `POST /api/t/{slug}/documents` accepts an `Idempotency-Key`, which the
-- contract on #2495 specifies. Step 1 (#2503) created `FarmDocument` without
-- anywhere to record it, so the header would have been accepted and ignored —
-- strictly worse than not accepting it, because it tells a client a retry is
-- safe when a retry would create a second document.
--
-- A document upload is the one write where a retry is MOST likely: the body
-- carries bytes, so a flaky rural connection is exactly the case the key
-- exists for. It is deliberately NOT an outbox surface (#2495: a multipart
-- body is the worst case for a queue that would have to replay a body it
-- cannot hold), so a visible failure plus a client retry under the same key
-- is the whole recovery story.
--
-- PARTIAL unique index, mirroring `StockTransaction_tenantId_idempotencyKey_key`:
-- a NULL key means the client sent no header, and those must never be
-- deduplicated against each other — two deliberate uploads of the same
-- contract are two documents.
--
-- ADD COLUMN is DDL, not a row UPDATE, so no trigger fires and existing rows
-- get NULL. Additive and nullable, so the previous image keeps working
-- against this schema and no `deploy/rollback/` inverse is required.

ALTER TABLE "FarmDocument" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "FarmDocument_tenantId_idempotencyKey_key"
    ON "FarmDocument" ("tenantId", "idempotencyKey")
    WHERE "idempotencyKey" IS NOT NULL;
