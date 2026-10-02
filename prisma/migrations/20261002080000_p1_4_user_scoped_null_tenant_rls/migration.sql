-- ═══════════════════════════════════════════════════════════════════
-- P1.4 — a NULL-tenant row belongs to ONE user, not to every app_user
-- ═══════════════════════════════════════════════════════════════════
--
-- `UserSession`, `NativeRefreshToken` and `NativeAuthCode` all carry a
-- nullable `tenantId` and all three got the Epic D.1 asymmetric policy:
--
--     USING ("tenantId" IS NULL OR "tenantId" = app.tenant_id)
--     WITH CHECK ("tenantId" = app.tenant_id)
--
-- The NULL arm is unconditional, so under `app_user` ANY session could read
-- EVERY null-tenant row of all three tables: session metadata (ipAddress,
-- userAgent, lastActiveAt), refresh-token rows and in-flight native auth
-- codes, for every user on the deployment. On the DELETE side it is a
-- session-takedown and token-revocation vector.
--
-- D.1's own comment says why the arm exists — "legitimate pre-tenant-resolution
-- sign-in state", because `recordNewSession` runs before a tenant is known. That
-- is still true. What it does not require is that the row be readable by
-- somebody ELSE, so the arm is narrowed to its own user rather than removed.
--
-- ── this is DEFENCE IN DEPTH placed ahead of the code that needs it ──
--
-- Measured 2026-10-02: NO code path reads any of these three tables under
-- `app_user`. Every access uses the global Prisma client (or an explicit
-- `asSystem(...)`), which never issues `SET LOCAL ROLE app_user`, so
-- `superuser_bypass` applies and these policies are INERT in production today.
-- The cross-user read described above is therefore not reachable through
-- current code — it is a loaded gun, not a live leak, and the thing that
-- would fire it is P1.5 routing person-scoped reads through `app_user`.
--
-- That ordering is why the policy is written to fail CLOSED. With
-- `app.user_id` unset, `"userId" = current_setting('app.user_id', true)`
-- evaluates to NULL, the OR arm is NULL, and a null-tenant row is INVISIBLE
-- under `app_user`. A future path that enters `app_user` without setting the
-- variable therefore sees zero rows rather than everyone's — the safe
-- direction for a control whose job is isolation.
-- `tests/guards/null-tenant-tables-not-read-as-app-user.test.ts` keeps the
-- measurement that makes this safe from going stale.
--
-- ── the single-policy form is still mandatory ──
--
-- Unchanged from D.1 and for the same reason: Postgres OR's permissive
-- policies on the same command, and a permissive policy with no WITH CHECK
-- implicitly grants WITH CHECK (true) on UPDATE for visible rows. Splitting
-- this into a read policy plus an insert policy would let an `app_user`-bound
-- session UPDATE a null-tenant row to any tenantId. One policy, two halves,
-- no permissive sibling to OR with.
--
-- `UserSession` is listed in `SINGLE_POLICY_EXCEPTIONS` in
-- `tests/guardrails/rls-coverage.test.ts`, whose post-loop sanity check
-- asserts the asymmetric qual/with_check shape is real.
--
-- Idempotent — safe to re-run.
-- ═══════════════════════════════════════════════════════════════════

-- ── UserSession ────────────────────────────────────────────────────
ALTER TABLE "UserSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserSession" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation        ON "UserSession";
DROP POLICY IF EXISTS tenant_isolation_insert ON "UserSession";
CREATE POLICY tenant_isolation ON "UserSession"
    USING (
        "tenantId" = current_setting('app.tenant_id', true)::text
        OR (
            "tenantId" IS NULL
            AND "userId" = current_setting('app.user_id', true)::text
        )
    )
    WITH CHECK (
        "tenantId" = current_setting('app.tenant_id', true)::text
    );

DROP POLICY IF EXISTS superuser_bypass ON "UserSession";
CREATE POLICY superuser_bypass ON "UserSession"
    USING (current_setting('role') != 'app_user');

-- ── NativeRefreshToken ─────────────────────────────────────────────
ALTER TABLE "NativeRefreshToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NativeRefreshToken" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation        ON "NativeRefreshToken";
DROP POLICY IF EXISTS tenant_isolation_insert ON "NativeRefreshToken";
CREATE POLICY tenant_isolation ON "NativeRefreshToken"
    USING (
        "tenantId" = current_setting('app.tenant_id', true)::text
        OR (
            "tenantId" IS NULL
            AND "userId" = current_setting('app.user_id', true)::text
        )
    )
    WITH CHECK (
        "tenantId" = current_setting('app.tenant_id', true)::text
    );

DROP POLICY IF EXISTS superuser_bypass ON "NativeRefreshToken";
CREATE POLICY superuser_bypass ON "NativeRefreshToken"
    USING (current_setting('role') != 'app_user');

-- ── NativeAuthCode ─────────────────────────────────────────────────
ALTER TABLE "NativeAuthCode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NativeAuthCode" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation        ON "NativeAuthCode";
DROP POLICY IF EXISTS tenant_isolation_insert ON "NativeAuthCode";
CREATE POLICY tenant_isolation ON "NativeAuthCode"
    USING (
        "tenantId" = current_setting('app.tenant_id', true)::text
        OR (
            "tenantId" IS NULL
            AND "userId" = current_setting('app.user_id', true)::text
        )
    )
    WITH CHECK (
        "tenantId" = current_setting('app.tenant_id', true)::text
    );

DROP POLICY IF EXISTS superuser_bypass ON "NativeAuthCode";
CREATE POLICY superuser_bypass ON "NativeAuthCode"
    USING (current_setting('role') != 'app_user');

-- ═══════════════════════════════════════════════════════════════════
-- P1.4, second half — the per-user ORG rules become READ-ONLY
-- ═══════════════════════════════════════════════════════════════════
--
-- Both org policies are `FOR ALL` with **no WITH CHECK**, and that is the
-- defect. Postgres uses a policy's USING expression as its check when WITH
-- CHECK is absent, so:
--
--   · `OrgMembership.org_membership_self_isolation`
--       USING ("userId" = app.user_id)
--     means an `app_user` session can INSERT a membership row for ITSELF —
--     a self-grant of org access, which is the whole thing org membership is
--     supposed to gate. It can also DELETE its own row, and UPDATE it to
--     another organizationId, because the row stays visible either way.
--
--   · `Organization.org_isolation`
--       USING (EXISTS (SELECT 1 FROM "OrgMembership" om WHERE …))
--     means a member can UPDATE the Organization row — rename it, repoint
--     whatever it carries. INSERT happens to fail (a brand-new organization
--     has no membership yet, so the check cannot pass), which is luck rather
--     than design.
--
-- Neither is reachable today, for the same two reasons as the first half: no
-- org query runs under `app_user`, and `app.user_id` is set by nothing in
-- `src/`, so `"userId" = NULL` filters every row. Measured 2026-10-02.
--
-- The fix is to say what was meant: these are READ rules. `FOR SELECT` leaves
-- no implicit write check to inherit, and with no write policy present an
-- `app_user` INSERT/UPDATE/DELETE is refused outright (42501). Every
-- legitimate writer — `org-tenants.ts`, `org-provisioning.ts`,
-- `org-members.ts` — uses the global client and is covered by
-- `superuser_bypass`.
--
-- Note the asymmetry with the first half, and that it is deliberate: the
-- session/token tables keep a WITH CHECK because writes to them under
-- `app_user` are a legitimate future shape (a tenant-scoped session row). An
-- org membership written by the person it grants access to is not.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE "OrgMembership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrgMembership" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_membership_self_isolation ON "OrgMembership";
CREATE POLICY org_membership_self_isolation ON "OrgMembership"
    FOR SELECT
    USING ("userId" = current_setting('app.user_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "OrgMembership";
CREATE POLICY superuser_bypass ON "OrgMembership"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Organization" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation ON "Organization";
CREATE POLICY org_isolation ON "Organization"
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1
              FROM "OrgMembership" om
             WHERE om."organizationId" = "Organization"."id"
               AND om."userId" = current_setting('app.user_id', true)::text
        )
    );

DROP POLICY IF EXISTS superuser_bypass ON "Organization";
CREATE POLICY superuser_bypass ON "Organization"
    USING (current_setting('role') != 'app_user');
