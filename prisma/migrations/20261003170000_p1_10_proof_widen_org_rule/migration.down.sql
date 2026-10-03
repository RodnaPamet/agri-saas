-- Restore the P1.4 shape: SELECT only, so a write under app_user has no policy
-- permitting it and is refused.
DROP POLICY IF EXISTS org_membership_self_isolation ON "OrgMembership";
CREATE POLICY org_membership_self_isolation ON "OrgMembership"
    FOR SELECT
    USING ("userId" = current_setting('app.user_id', true)::text);
