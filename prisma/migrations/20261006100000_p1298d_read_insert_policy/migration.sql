-- #1298 — `ExchangeThreadRead` needs a FOR INSERT policy of its own.
--
-- Caught by `tests/guardrails/rls-coverage.test.ts`, which requires every
-- model carrying a direct `tenantId` to have `tenant_isolation_insert`:
--
--   INSERT-protection gap — 1 direct-tenantId model(s) have no
--   'tenant_isolation_insert' FOR INSERT WITH CHECK policy. Without it, a
--   tenant running under app_user could insert a row carrying another
--   tenant's id.
--
-- The `FOR ALL` policy's WITH CHECK does cover INSERT today, so this is
-- defence in depth rather than a live hole — but the guard is right to demand
-- it by name: the day someone narrows the FOR ALL policy to SELECT, the
-- INSERT protection would vanish with it and nothing would say so.
--
-- Stricter than the canonical form on purpose: a read pointer is private to
-- its reader, so the person clause rides along with the tenant clause.
CREATE POLICY tenant_isolation_insert ON "ExchangeThreadRead"
    FOR INSERT
    WITH CHECK (
        "tenantId" = current_setting('app.tenant_id', true)::text
        AND "userId" = current_setting('app.actor_user_id', true)::text
    );
