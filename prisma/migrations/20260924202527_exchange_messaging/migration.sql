-- Exchange messaging: a thread per (listing, inquirer tenant).
--
-- `ExchangeInquiry` is one-shot — a message, a contact, a status. A
-- marketplace needs the two sides to go back and forth before either commits.
--
-- ── Why these tables carry no tenantId ──
--
-- Every other table here is owned by ONE tenant and gets `tenant_isolation`
-- keyed on `tenantId = current_setting('app.tenant_id')`. A thread is owned by
-- NEITHER party and read by BOTH, so that policy cannot express it: whichever
-- tenant we stamped on the row, the other one could not see it.
--
-- The repo already solved this once, for `ExchangeInquiry`. These policies are
-- that solution applied again — admit the inquirer tenant, or the seller
-- tenant reached through the listing. Copying the proven shape rather than
-- inventing a second cross-tenant idiom is the point.

-- CreateTable
CREATE TABLE "ExchangeThread" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "inquirerTenantId" TEXT NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Read pointers, one per party. Monotonic in the usecase.
    "sellerLastReadAt" TIMESTAMP(3),
    "inquirerLastReadAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExchangeThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExchangeMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "senderTenantId" TEXT NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    -- Tombstone, never a hard delete: a hole in the other party's scrollback
    -- reads as data loss rather than as a retraction.
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExchangeMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeThread_listingId_inquirerTenantId_key"
    ON "ExchangeThread" ("listingId", "inquirerTenantId");
CREATE INDEX "ExchangeThread_inquirerTenantId_lastMessageAt_idx"
    ON "ExchangeThread" ("inquirerTenantId", "lastMessageAt");
CREATE INDEX "ExchangeThread_listingId_idx" ON "ExchangeThread" ("listingId");
CREATE INDEX "ExchangeMessage_threadId_createdAt_idx"
    ON "ExchangeMessage" ("threadId", "createdAt");
CREATE INDEX "ExchangeMessage_senderTenantId_idx"
    ON "ExchangeMessage" ("senderTenantId");

-- AddForeignKey
ALTER TABLE "ExchangeThread" ADD CONSTRAINT "ExchangeThread_listingId_fkey"
    FOREIGN KEY ("listingId") REFERENCES "ExchangeListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExchangeMessage" ADD CONSTRAINT "ExchangeMessage_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "ExchangeThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Row-level security: party isolation, not tenant isolation ──
ALTER TABLE "ExchangeThread" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExchangeThread" FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS exchange_thread_party_isolation ON "ExchangeThread";
DROP POLICY IF EXISTS superuser_bypass                ON "ExchangeThread";

CREATE POLICY exchange_thread_party_isolation ON "ExchangeThread"
    USING (
        "inquirerTenantId" = current_setting('app.tenant_id', true)::text
        OR EXISTS (
            SELECT 1 FROM "ExchangeListing" l
            WHERE l."id" = "ExchangeThread"."listingId"
              AND l."sellerTenantId" = current_setting('app.tenant_id', true)::text
        )
    )
    WITH CHECK (
        "inquirerTenantId" = current_setting('app.tenant_id', true)::text
        OR EXISTS (
            SELECT 1 FROM "ExchangeListing" l
            WHERE l."id" = "ExchangeThread"."listingId"
              AND l."sellerTenantId" = current_setting('app.tenant_id', true)::text
        )
    );

CREATE POLICY superuser_bypass ON "ExchangeThread"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "ExchangeMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExchangeMessage" FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS exchange_message_party_isolation ON "ExchangeMessage";
DROP POLICY IF EXISTS superuser_bypass                 ON "ExchangeMessage";

-- Reached through the thread, so the rule lives in ONE place. A message is
-- visible exactly when its thread is.
CREATE POLICY exchange_message_party_isolation ON "ExchangeMessage"
    USING (
        EXISTS (
            SELECT 1 FROM "ExchangeThread" t
            JOIN "ExchangeListing" l ON l."id" = t."listingId"
            WHERE t."id" = "ExchangeMessage"."threadId"
              AND (
                t."inquirerTenantId" = current_setting('app.tenant_id', true)::text
                OR l."sellerTenantId" = current_setting('app.tenant_id', true)::text
              )
        )
    )
    WITH CHECK (
        -- A party may only write as THEMSELVES. Without this a party with
        -- direct SQL access could attribute a message to the other side.
        "senderTenantId" = current_setting('app.tenant_id', true)::text
        AND EXISTS (
            SELECT 1 FROM "ExchangeThread" t
            JOIN "ExchangeListing" l ON l."id" = t."listingId"
            WHERE t."id" = "ExchangeMessage"."threadId"
              AND (
                t."inquirerTenantId" = current_setting('app.tenant_id', true)::text
                OR l."sellerTenantId" = current_setting('app.tenant_id', true)::text
              )
        )
    );

CREATE POLICY superuser_bypass ON "ExchangeMessage"
    USING (current_setting('role') != 'app_user');
