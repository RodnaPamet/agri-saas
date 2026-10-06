-- #1298 follow-up — give `ExchangeThreadRead`'s policy the canonical name.
--
-- The policy shipped in `20261004010000_p1298_private_exchange_conversations`
-- as `exchange_thread_read_own`. `tests/guardrails/rls-coverage.test.ts`
-- requires every model carrying a `tenantId` column to have a policy named
-- literally `tenant_isolation` (plus `superuser_bypass`), and this model does
-- carry one — so the original name would have failed that guard.
--
-- This is a SECOND migration rather than an edit to the first, deliberately.
-- The first had already been applied to a test database, and editing an
-- applied migration breaks its checksum on the next `migrate deploy`. The
-- alternatives were to reset that database — which `prisma migrate reset`
-- refuses when invoked by an agent, a refusal worth respecting rather than
-- routing around with hand-written DDL — so the honest artifact is two
-- migrations that compose, which is also what any other contributor would
-- have had to ship once the first was out.
--
-- The name is accurate, not a formality: the predicate isolates by tenant AND
-- additionally by PERSON, because a read pointer is private to its reader. The
-- tenant clause is now in USING as well as WITH CHECK, so the policy is a
-- genuine tenant_isolation policy that happens to be stricter.

DROP POLICY IF EXISTS exchange_thread_read_own ON "ExchangeThreadRead";

CREATE POLICY tenant_isolation ON "ExchangeThreadRead"
    USING (
        "tenantId" = current_setting('app.tenant_id', true)::text
        AND "userId" = current_setting('app.actor_user_id', true)::text
    )
    WITH CHECK (
        "tenantId" = current_setting('app.tenant_id', true)::text
        AND "userId" = current_setting('app.actor_user_id', true)::text
    );

-- ── idempotency follows the sending PERSON ───────────────────────────────
--
-- `ExchangeMessage.clientMutationId` was unique per (senderTenantId, key).
-- With conversations private to people, two colleagues reusing the same
-- client-side id — which they will, because the id is minted per device —
-- would collide, and one send would silently dedupe into the other's message.
-- An idempotency key belongs to whoever minted it.
--
-- Every NULL is distinct in Postgres, so callers sending no key are
-- unaffected by either form.
DROP INDEX IF EXISTS "ExchangeMessage_senderTenantId_clientMutationId_key";
CREATE UNIQUE INDEX "ExchangeMessage_senderUserId_clientMutationId_key"
    ON "ExchangeMessage" ("senderUserId", "clientMutationId");

