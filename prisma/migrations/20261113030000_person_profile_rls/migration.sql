-- #3007 — PersonProfile gets its policies, now that a reader exists.
--
-- The P6.1 migration chose NO policy, and said why: "no reader of any kind
-- yet", with the table shipping a release before its writer. It also named the
-- condition for revisiting, and `rls-coverage`'s own entry repeats it: "The
-- policy belongs to the FIRST PR that routes a person-scoped read through
-- app_user."
--
-- #2989 was that PR and did not bring the policy with it. `resolveAuthors`
-- reads this table on every channel feed and every thread read, and
-- `runInUserContext` does `SET LOCAL ROLE app_user` — so the premise the
-- earlier decision rested on is now false. With RLS disabled and
-- `ALTER DEFAULT PRIVILEGES` (20260323180000) granting app_user full DML on
-- every new table in public, the `published = true` clause in that query is
-- the ONLY thing between an unpublished display name and every authenticated
-- caller, and nothing at all stops a future user-context write path from
-- editing somebody else's row.
--
-- ── WHY FIVE PER-COMMAND POLICIES AND NOT ONE `ALL` ──
--
-- The read and the write admit DIFFERENT rows, which is precisely the shape
-- CLAUDE.md records for `ExchangeBlock` and against `UserSession`:
--
--   SELECT   a published row belongs to everyone (the author line is the
--            feature), plus your own row whether published or not, so the
--            editor can read back what it is about to publish
--   INSERT   your own row only
--   UPDATE   your own row only
--
-- A single `ALL` policy whose USING clause said `published = true OR own`
-- would govern UPDATE too, and hand every authenticated caller the ability to
-- rewrite any published display name on the platform. That is the same
-- mistake in the opposite direction from `UserSession`, where a SPLIT pair
-- would have let `app_user` claim a NULL-tenant row — one table wants one
-- policy, this one wants five, and the question is always which commands the
-- same row set answers for.
--
-- ── NO DELETE ARM, DELIBERATELY ──
--
-- Erasure runs privileged (`eraseAccount` on the global client), so it needs
-- none; and a person deleting their profile row would take their channel
-- authorship with it, which `setOwnDisplayName(null)` already expresses
-- properly by clearing the name and unpublishing. A missing arm is a refusal
-- that affects zero rows and raises nothing, which is why it is written down
-- here rather than left to be inferred.

ALTER TABLE "PersonProfile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PersonProfile" FORCE  ROW LEVEL SECURITY;

-- The author line: a published profile is readable by any authenticated
-- caller, across every farm. That cross-farm read IS the feature the owner
-- approved on 2026-11-12, and `published` is the boundary.
CREATE POLICY person_profile_select_published ON "PersonProfile"
    FOR SELECT USING (
        current_setting('app.user_id', true) IS NOT NULL
        AND current_setting('app.user_id', true) <> ''
        AND "published" = true
    );

-- Your own row, published or not, so the editor can read back a draft.
CREATE POLICY person_profile_select_own ON "PersonProfile"
    FOR SELECT USING ("userId" = current_setting('app.user_id', true));

CREATE POLICY person_profile_insert_own ON "PersonProfile"
    FOR INSERT WITH CHECK ("userId" = current_setting('app.user_id', true));

CREATE POLICY person_profile_update_own ON "PersonProfile"
    FOR UPDATE USING ("userId" = current_setting('app.user_id', true))
          WITH CHECK ("userId" = current_setting('app.user_id', true));

CREATE POLICY superuser_bypass ON "PersonProfile"
    USING (current_setting('role') != 'app_user');
