-- #1325 — the anchor for the 14-day PAST_DUE grace.
--
-- Purely additive and nullable, so the previous image keeps working: it never
-- reads or writes this column, and a row it updates leaves the value alone.
-- No `deploy/rollback` inverse is required for that reason (the convention is
-- renames, drops and data rewrites).
--
-- NULL is load-bearing, not merely the default. Every existing PAST_DUE row
-- gets NULL, and `resolvePastDueState` reads NULL as IN-GRACE rather than as
-- "the grace expired long ago" — which would restrict every already-failing
-- tenant on the first request after this deploys, with no warning and none of
-- the fourteen days the owner ruled for. Backfilling `now()` here was the
-- alternative and is worse: it would be a lie about when payment failed,
-- written into the column a user-visible countdown is computed from.
ALTER TABLE "BillingAccount" ADD COLUMN "pastDueSince" TIMESTAMP(3);

-- Supports the only query shape that is not a by-tenant point read: finding
-- accounts whose grace has elapsed, for the admin billing surface. Partial,
-- because a NULL here is the overwhelming majority and is never searched for.
CREATE INDEX "BillingAccount_pastDueSince_idx"
    ON "BillingAccount"("pastDueSince")
    WHERE "pastDueSince" IS NOT NULL;
