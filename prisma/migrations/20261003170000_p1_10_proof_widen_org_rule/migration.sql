-- ████ MUTATION B — P1.10 PROOF MIGRATION. DO NOT MERGE. ████
--
-- Re-adds the pre-P1.4 `org_membership_self_isolation` policy: no `FOR SELECT`,
-- so it covers ALL commands and its USING expression doubles as the INSERT's
-- WITH CHECK. That is a self-grant — an ORG_ADMIN can insert their own
-- membership row.
--
-- This exists ONLY to measure that CI goes red. P1.10 requires that re-adding
-- the org write rule turns CI red, and a local jest run is not that
-- measurement: it does not prove the migration is applied before the tests, or
-- that the suite which catches it is in a REQUIRED check.
--
-- `tests/integration/null-tenant-user-scoping.test.ts` is the catcher:
-- "an app_user self-INSERT into OrgMembership is refused (42501)".
--
-- The branch carrying this is closed, never merged.
DROP POLICY IF EXISTS org_membership_self_isolation ON "OrgMembership";
CREATE POLICY org_membership_self_isolation ON "OrgMembership"
    USING ("userId" = current_setting('app.user_id', true)::text);
