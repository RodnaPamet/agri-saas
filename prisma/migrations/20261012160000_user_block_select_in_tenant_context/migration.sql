-- #1664 — the person-level block did not enforce, because the row was
-- invisible in the context the enforcement runs in.
--
-- `UserBlock`'s SELECT policy keys on `app.user_id`, which `runInUserContext`
-- sets. The enforcement lives in `requireParty`, which runs inside
-- `runInTenantContext` — and that helper sets `app.tenant_id`,
-- `app.request_id` and `app.actor_user_id`, never `app.user_id`. So
-- `personBlockExists` and `amIBlockedByAnyOf` selected from an empty view and
-- returned false for every pair, always. Measured, with a positive control:
-- the same row counted 1 under a user context and 0 under a tenant context.
--
-- This arm admits EXACTLY the same two people — blocker and blocked — keyed on
-- the variable the tenant context does set. It widens nothing: a person who can
-- already read their own block rows under `runInUserContext` reads the same rows
-- under `runInTenantContext`, and nobody else gains anything.
--
-- SELECT ONLY, deliberately. INSERT/UPDATE/DELETE stay `app.user_id`-keyed
-- because the social block routes are person-scoped (`/api/social/blocks` via
-- `getUserCtx`), so every WRITE happens under a user context. Adding tenant-
-- context write arms would let a thread path create or remove a person block,
-- which is not where that decision belongs — and a DELETE arm in particular
-- would hand the blocked party a way to unblock themselves, which is the
-- reason P5.1 split these policies per command in the first place.
--
-- The two rejected alternatives are recorded on #1664: reading through the
-- privileged client (a second pool connection inside an open transaction —
-- #1191's P0.8 deadlock), and setting `app.user_id` inside
-- `runInTenantContext` (which would start admitting `ContentReport`'s
-- reporter-read rows inside every tenant transaction, a disclosure change
-- nobody asked for).
DROP POLICY IF EXISTS user_block_select_actor ON "UserBlock";

CREATE POLICY user_block_select_actor ON "UserBlock"
    FOR SELECT
    USING (
        "blockerUserId" = current_setting('app.actor_user_id', true)::text
        OR "blockedUserId" = current_setting('app.actor_user_id', true)::text
    );
