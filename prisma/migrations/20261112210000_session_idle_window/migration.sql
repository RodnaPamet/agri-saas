-- #3004 — the session cap becomes an IDLE window for native clients.
--
-- Two statements, and only the second one touches existing data.
--
-- The backfill is scoped to rows holding EXACTLY the old default. A tenant
-- that chose its own number keeps it: 10080 stays 10080, and the point of
-- sliding by the tenant's own figure is that a configured security control
-- goes on being honoured. A row still at 20160 cannot be told apart from one
-- that was never considered, since that was the value every row got for free,
-- and raising those is what the owner authorised directly (2026-11-12) when
-- asked whether existing farms should move.
--
-- There is no down-migration beside this one by design: the change is a
-- DEFAULT plus an UPDATE of a nullable integer, so the previous image reads
-- and writes this column exactly as before. Nothing is renamed, dropped or
-- re-encoded, which is the test `destructive-migration-has-inverse` applies.

ALTER TABLE "TenantSecuritySettings"
    ALTER COLUMN "sessionMaxAgeMinutes" SET DEFAULT 43200;

UPDATE "TenantSecuritySettings"
   SET "sessionMaxAgeMinutes" = 43200
 WHERE "sessionMaxAgeMinutes" = 20160;
