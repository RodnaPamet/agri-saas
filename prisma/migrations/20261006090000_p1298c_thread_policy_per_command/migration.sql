-- #1298 — split the thread policy BY COMMAND. `WITH CHECK` governs UPDATE too.
--
-- `20261004010000`'s `exchange_thread_audience` carried
--
--   WITH CHECK (inquirerUserId = app.actor_user_id
--               AND inquirerTenantId = app.tenant_id)
--
-- on the reasoning that a thread may only be OPENED by the person it names.
-- That is right for INSERT and wrong for UPDATE, because `WITH CHECK` governs
-- both: the seller replying updates the thread's denormalised `lastMessageAt`,
-- and that UPDATE was refused outright —
--
--   Code: 42501  new row violates row-level security policy for "ExchangeThread"
--
-- Caught by `tests/integration/exchange-private-conversations.test.ts`, which
-- drives a real reply from the seller side. A policy test that only READ rows
-- would have passed straight over it, which is why that file sends as well as
-- reads.
--
-- The split mirrors what `ExchangeBlock` already does in this schema —
-- "enforced by separate per-command policies rather than one USING clause". A
-- PERMISSIVE `FOR ALL` policy carries the audience; a RESTRICTIVE INSERT-only
-- policy carries "the row names you". Restrictive policies are AND-ed with
-- permissive ones, so an INSERT must satisfy both while an UPDATE answers only
-- to the audience.
--
-- This is a third migration rather than an edit to either earlier one: both
-- had already been applied to a test database by the jest harness, which runs
-- `migrate deploy` in `globalSetup`. Editing an applied migration breaks its
-- checksum, and `prisma migrate reset` refuses to run when invoked by an
-- agent — a refusal worth respecting rather than routing around with
-- hand-written destructive DDL. Three migrations that compose is the honest
-- artifact; the lesson for next time is to write the whole policy before
-- running a test that applies it.

DROP POLICY IF EXISTS exchange_thread_audience ON "ExchangeThread";

CREATE POLICY exchange_thread_audience ON "ExchangeThread"
    FOR ALL
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
    );

-- The half a permissive policy cannot express once UPDATE is allowed: a NEW
-- thread must name its own opener, so nobody opens a conversation in a
-- colleague's name.
CREATE POLICY exchange_thread_insert_names_self ON "ExchangeThread"
    AS RESTRICTIVE
    FOR INSERT
    WITH CHECK (
        "inquirerUserId" = current_setting('app.actor_user_id', true)::text
        AND "inquirerTenantId" = current_setting('app.tenant_id', true)::text
    );
