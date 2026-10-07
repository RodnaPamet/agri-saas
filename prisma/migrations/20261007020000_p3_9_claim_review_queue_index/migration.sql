-- P3.9 — an index for the staff review queue.
--
-- The queue is `WHERE status = 'PENDING' ORDER BY "createdAt" ASC`, and it is
-- CROSS-TENANT: a platform reviewer looks at every farm's claims, and the
-- collision case is by definition two different tenants. So neither existing
-- index serves it. `(tenantId)` leads with a column the query never mentions,
-- and `(eikHash)` is for the "is this ЕИК claimed" lookup.
--
-- `(status, createdAt)` leads with the equality predicate and follows with the
-- sort key, so the queue is an index scan rather than a filter-then-sort over
-- the whole table. Today that table has zero rows in production, which is
-- exactly when an index is free to add.
--
-- Required by `tests/guardrails/schema-index-coverage.test.ts`, which refused
-- the alternative — claiming the tenant index was sufficient would have been
-- false for a query with no tenant predicate.

CREATE INDEX "FarmIdentityClaim_status_createdAt_idx"
    ON "FarmIdentityClaim"("status", "createdAt");
