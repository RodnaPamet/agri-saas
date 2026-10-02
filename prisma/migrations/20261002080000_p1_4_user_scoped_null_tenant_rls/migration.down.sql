-- ═══════════════════════════════════════════════════════════════════
-- Inverse of P1.4 — restore the Epic D.1 unconditional NULL-tenant arm.
-- ═══════════════════════════════════════════════════════════════════
--
-- One transaction, and it deletes its own `_prisma_migrations` row so a later
-- roll-forward re-applies rather than silently skipping.
--
-- WHAT ROLLING BACK COSTS, stated plainly: it restores a policy under which any
-- `app_user` session can read every null-tenant session row, refresh token and
-- native auth code on the deployment. That is survivable only because no code
-- path reads these tables under `app_user` — the same measurement that makes
-- the forward migration safe. Do NOT roll this back after P1.5 has routed
-- person-scoped reads through `app_user`; by then the permissive arm is a live
-- cross-user read rather than a dormant one.
--
-- This inverse exists because the forward migration REPLACES a policy rather
-- than adding one, so the previous image's behaviour cannot be recovered by
-- pinning Watchtower back — the schema object is gone. `DROP POLICY` is not in
-- the destructive set `destructive-migration-has-inverse.test.ts` derives
-- (DROP TABLE / COLUMN / TYPE / RENAME), so nothing demanded this file; it is
-- here because the rule it encodes — "add one whenever a migration would break
-- the previous image" — applies to a replaced policy just as much.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.p1_4_restore_d1(tbl text) RETURNS void AS $fn$
BEGIN
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', tbl);
    EXECUTE format($q$
        CREATE POLICY tenant_isolation ON %I
            USING (
                "tenantId" IS NULL
                OR "tenantId" = current_setting('app.tenant_id', true)::text
            )
            WITH CHECK (
                "tenantId" = current_setting('app.tenant_id', true)::text
            )
    $q$, tbl);
END;
$fn$ LANGUAGE plpgsql;

SELECT pg_temp.p1_4_restore_d1('UserSession');
SELECT pg_temp.p1_4_restore_d1('NativeRefreshToken');
SELECT pg_temp.p1_4_restore_d1('NativeAuthCode');

-- Restore the FOR ALL org policies. Same warning as above: rolling back
-- re-opens the self-grant on OrgMembership and the member UPDATE on
-- Organization, both of which are dormant only while no org query runs under
-- `app_user`.
DROP POLICY IF EXISTS org_membership_self_isolation ON "OrgMembership";
CREATE POLICY org_membership_self_isolation ON "OrgMembership"
    USING ("userId" = current_setting('app.user_id', true)::text);

DROP POLICY IF EXISTS org_isolation ON "Organization";
CREATE POLICY org_isolation ON "Organization"
    USING (
        EXISTS (
            SELECT 1
              FROM "OrgMembership" om
             WHERE om."organizationId" = "Organization"."id"
               AND om."userId" = current_setting('app.user_id', true)::text
        )
    );

DELETE FROM "_prisma_migrations"
 WHERE "migration_name" = '20261002080000_p1_4_user_scoped_null_tenant_rls';

COMMIT;
