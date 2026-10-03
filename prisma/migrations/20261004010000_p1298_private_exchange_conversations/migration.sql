-- #1298 — exchange conversations become private to PEOPLE, not shared by the farm.
--
-- Found by the P0.9 two-phone test: a second member of a farm could read and
-- use the farm's conversation with another farm, including what the first
-- member had written. That was by design — a thread's parties were TENANTS.
--
-- This migration is EXPAND-ONLY on purpose. It drops no column and rewrites no
-- persisted value that the previous image still reads, so rolling the image
-- back leaves a working system: `sellerLastReadAt` / `inquirerLastReadAt` stay
-- in place and are dual-written for the two principals during this phase. The
-- contract phase that drops them is a separate migration with its own inverse.
--
-- The one non-additive change is the uniqueness key, (listing, inquirer tenant)
-- -> (listing, inquirer user). The previous image would then permit two threads
-- per (listing, inquirer tenant) where it used to permit one; it never created
-- a second, so the loosened constraint is inert on rollback.

-- ── 1. the buyer-side principal ────────────────────────────────────────────
-- Nullable first, backfilled, then NOT NULL: an unresolvable row fails the
-- SET NOT NULL inside this transaction rather than being invented an owner.
ALTER TABLE "ExchangeThread" ADD COLUMN "inquirerUserId" TEXT;

-- Prefer the person who actually wrote from the inquirer side.
UPDATE "ExchangeThread" t
   SET "inquirerUserId" = (
        SELECT m."senderUserId"
          FROM "ExchangeMessage" m
         WHERE m."threadId" = t."id"
           AND m."senderTenantId" = t."inquirerTenantId"
         ORDER BY m."createdAt" ASC
         LIMIT 1
   )
 WHERE t."inquirerUserId" IS NULL;

-- A thread can legitimately be EMPTY: `openExchangeThread` creates the row
-- before any message exists. Those fall back to the inquirer farm's
-- longest-standing active OWNER/ADMIN, which is the audience that would have
-- been able to see it anyway.
UPDATE "ExchangeThread" t
   SET "inquirerUserId" = (
        SELECT tm."userId"
          FROM "TenantMembership" tm
         WHERE tm."tenantId" = t."inquirerTenantId"
           AND tm."status" = 'ACTIVE'
           AND tm."role" IN ('OWNER', 'ADMIN')
         ORDER BY tm."createdAt" ASC
         LIMIT 1
   )
 WHERE t."inquirerUserId" IS NULL;

ALTER TABLE "ExchangeThread" ALTER COLUMN "inquirerUserId" SET NOT NULL;

-- ── 2. identity moves to the person ───────────────────────────────────────
DROP INDEX IF EXISTS "ExchangeThread_listingId_inquirerTenantId_key";
CREATE UNIQUE INDEX "ExchangeThread_listingId_inquirerUserId_key"
    ON "ExchangeThread" ("listingId", "inquirerUserId");
CREATE INDEX "ExchangeThread_inquirerUserId_lastMessageAt_idx"
    ON "ExchangeThread" ("inquirerUserId", "lastMessageAt");

-- ── 3. per-person read state ──────────────────────────────────────────────
CREATE TABLE "ExchangeThreadRead" (
    "id"         TEXT NOT NULL,
    "threadId"   TEXT NOT NULL,
    "userId"     TEXT NOT NULL,
    "tenantId"   TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExchangeThreadRead_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ExchangeThreadRead_threadId_userId_key"
    ON "ExchangeThreadRead" ("threadId", "userId");
CREATE INDEX "ExchangeThreadRead_userId_threadId_idx"
    ON "ExchangeThreadRead" ("userId", "threadId");
CREATE INDEX "ExchangeThreadRead_tenantId_idx" ON "ExchangeThreadRead" ("tenantId");
ALTER TABLE "ExchangeThreadRead"
    ADD CONSTRAINT "ExchangeThreadRead_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "ExchangeThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry the two existing pointers over to their principals, so nobody's
-- already-read scrollback comes back unread.
INSERT INTO "ExchangeThreadRead" ("id","threadId","userId","tenantId","lastReadAt","createdAt","updatedAt")
SELECT gen_random_uuid()::text, t."id", t."inquirerUserId", t."inquirerTenantId",
       t."inquirerLastReadAt", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "ExchangeThread" t
 WHERE t."inquirerLastReadAt" IS NOT NULL;

INSERT INTO "ExchangeThreadRead" ("id","threadId","userId","tenantId","lastReadAt","createdAt","updatedAt")
SELECT gen_random_uuid()::text, t."id", l."sellerUserId", l."sellerTenantId",
       t."sellerLastReadAt", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "ExchangeThread" t
  JOIN "ExchangeListing" l ON l."id" = t."listingId"
 WHERE t."sellerLastReadAt" IS NOT NULL
 ON CONFLICT ("threadId","userId") DO NOTHING;

-- ── 4. RLS: the audience, not the farm ────────────────────────────────────
--
-- `app.tenant_id` cannot tell two members of one farm apart, so the old policy
-- could not express this. A NEW session variable `app.actor_user_id` is set by
-- `runInTenantContext` alongside the tenant.
--
-- It is deliberately NOT the existing `app.user_id`. That variable is set only
-- by `runInUserContext` and is read by the two-armed policy on NativeAuthCode,
-- NativeRefreshToken, Organization, OrgMembership and UserSession
-- (`tenantId = app.tenant_id OR (tenantId IS NULL AND userId = app.user_id)`).
-- Setting it inside a tenant context would open that second arm on all five,
-- blurring a separation whose own docblock says the separation is the point.
-- A new name changes the evaluation of exactly zero existing policies.
--
-- The audience is three predicates, matching the owner's decisions:
--   1. the person who opened the thread            (#1298 decision 3)
--   2. the person who created the listing          (#1298 decision 1)
--   3. an ACTIVE OWNER/ADMIN of either party farm  (#1298 decisions 1 and 3)
--
-- Clause 3 constrains `tm."tenantId"` to `app.tenant_id` explicitly as well as
-- to a party farm. TenantMembership is FORCE RLS, so the subquery would be
-- filtered to the caller's own tenant anyway — stating it makes the intent
-- readable instead of an emergent property of another table's policy.
DROP POLICY IF EXISTS exchange_thread_party_isolation ON "ExchangeThread";

CREATE POLICY exchange_thread_audience ON "ExchangeThread"
    USING (
        "inquirerUserId" = current_setting('app.actor_user_id', true)::text
        OR EXISTS (
            SELECT 1 FROM "ExchangeListing" l
            WHERE l."id" = "ExchangeThread"."listingId"
              AND l."sellerUserId" = current_setting('app.actor_user_id', true)::text
        )
        OR EXISTS (
            SELECT 1
              FROM "ExchangeListing" l
              JOIN "TenantMembership" tm
                ON tm."userId" = current_setting('app.actor_user_id', true)::text
               AND tm."status" = 'ACTIVE'
               AND tm."role" IN ('OWNER', 'ADMIN')
               AND tm."tenantId" = current_setting('app.tenant_id', true)::text
               AND tm."tenantId" IN ("ExchangeThread"."inquirerTenantId", l."sellerTenantId")
             WHERE l."id" = "ExchangeThread"."listingId"
        )
    )
    WITH CHECK (
        -- A thread may only be opened BY the person it names, and only against
        -- someone else's listing. Without the first conjunct a member with
        -- direct SQL access could open a conversation in a colleague's name.
        "inquirerUserId" = current_setting('app.actor_user_id', true)::text
        AND "inquirerTenantId" = current_setting('app.tenant_id', true)::text
    );

-- Messages follow their thread, and that is load-bearing rather than lazy.
-- `app_user` does not own these tables and FORCE ROW LEVEL SECURITY is on, so
-- this EXISTS is itself evaluated under `exchange_thread_audience` — a thread
-- the caller cannot see yields no row here and the message is invisible. One
-- definition of the audience, not two that can drift apart. There is no
-- recursion: the thread policy references ExchangeListing and TenantMembership
-- and never ExchangeMessage.
-- `tests/integration/exchange-private-conversations.test.ts` proves the
-- consequence directly (a non-audience colleague reads zero messages), because
-- a comment asserting a nested-policy property is not evidence of it.
DROP POLICY IF EXISTS exchange_message_party_isolation ON "ExchangeMessage";

CREATE POLICY exchange_message_audience ON "ExchangeMessage"
    USING (
        EXISTS (
            SELECT 1 FROM "ExchangeThread" t
            WHERE t."id" = "ExchangeMessage"."threadId"
        )
    )
    WITH CHECK (
        -- A person may only write as THEMSELVES, and only into a thread they
        -- can see. The sender tenant stays pinned too: it is what the
        -- idempotency key and the block check scope by.
        "senderUserId" = current_setting('app.actor_user_id', true)::text
        AND "senderTenantId" = current_setting('app.tenant_id', true)::text
        AND EXISTS (
            SELECT 1 FROM "ExchangeThread" t
            WHERE t."id" = "ExchangeMessage"."threadId"
        )
    );

-- ── 5. read state is private to its reader ────────────────────────────────
ALTER TABLE "ExchangeThreadRead" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExchangeThreadRead" FORCE ROW LEVEL SECURITY;

CREATE POLICY exchange_thread_read_own ON "ExchangeThreadRead"
    USING ("userId" = current_setting('app.actor_user_id', true)::text)
    WITH CHECK (
        "userId" = current_setting('app.actor_user_id', true)::text
        AND "tenantId" = current_setting('app.tenant_id', true)::text
    );

CREATE POLICY superuser_bypass ON "ExchangeThreadRead"
    USING (current_setting('role') != 'app_user');
