-- #1298 — the audience is PERSON-scoped AND TENANT-scoped, not either alone.
--
-- `20261006090000`'s principal clauses were
--
--   "inquirerUserId" = app.actor_user_id
--   OR EXISTS (... l."sellerUserId" = app.actor_user_id)
--
-- with no reference to `app.tenant_id`. So the thread's opener matched from
-- ANY tenant context — including a farm that is not a party to the
-- conversation. Surfaced while updating `exchange-messaging-rls.test.ts`,
-- whose outsider-tenant case passes a tenant that is not a party: with one
-- shared fixture user, that user was the principal and the clause let them
-- read the row from the outsider context.
--
-- Not a leak against the person — a thread's opener reading their own
-- conversation is the point — but it is a hole in the TENANT boundary, which
-- CLAUDE.md calls the layer that makes isolation impossible to bypass by
-- accident. A thread belongs to a (person, farm) PAIR; both halves belong in
-- the predicate. The admin clause already pinned `tm."tenantId"` to
-- `app.tenant_id`, so only the two principal clauses needed it.

DROP POLICY IF EXISTS exchange_thread_audience ON "ExchangeThread";

CREATE POLICY exchange_thread_audience ON "ExchangeThread"
    FOR ALL
    USING (
        (
            "inquirerUserId" = current_setting('app.actor_user_id', true)::text
            AND "inquirerTenantId" = current_setting('app.tenant_id', true)::text
        )
        OR EXISTS (
            SELECT 1 FROM "ExchangeListing" l
            WHERE l."id" = "ExchangeThread"."listingId"
              AND l."sellerUserId" = current_setting('app.actor_user_id', true)::text
              AND l."sellerTenantId" = current_setting('app.tenant_id', true)::text
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
        (
            "inquirerUserId" = current_setting('app.actor_user_id', true)::text
            AND "inquirerTenantId" = current_setting('app.tenant_id', true)::text
        )
        OR EXISTS (
            SELECT 1 FROM "ExchangeListing" l
            WHERE l."id" = "ExchangeThread"."listingId"
              AND l."sellerUserId" = current_setting('app.actor_user_id', true)::text
              AND l."sellerTenantId" = current_setting('app.tenant_id', true)::text
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
-- Idempotent: this policy already exists from `20261006090000`, and this
-- migration recreates it only to keep the two halves of the split in one
-- readable place.
DROP POLICY IF EXISTS exchange_thread_insert_names_self ON "ExchangeThread";

CREATE POLICY exchange_thread_insert_names_self ON "ExchangeThread"
    AS RESTRICTIVE
    FOR INSERT
    WITH CHECK (
        "inquirerUserId" = current_setting('app.actor_user_id', true)::text
        AND "inquirerTenantId" = current_setting('app.tenant_id', true)::text
    );
