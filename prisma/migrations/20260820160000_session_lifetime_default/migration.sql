-- Issue #618 — every tenant was on a 30-day session nobody chose.
--
-- The product default is now 14 days (`@/lib/auth/session-lifetime`). This
-- gives the column a matching non-null DEFAULT and backfills the rows that
-- were relying on the framework default by being NULL.
--
-- Deliberately NOT a NOT NULL constraint: NULL still means "no tenant-specific
-- cap", and that now falls back to the same 14 days in application code. Adding
-- NOT NULL would reject an explicit null write from the previous image for no
-- behavioural gain.
--
-- No operator is signed out by this. `recordNewSession` applies the cap at
-- INSERT time only (src/lib/security/session-tracker.ts), so existing
-- UserSession rows keep the `expiresAt` they were minted with; only sessions
-- created after this migration are shortened.

ALTER TABLE "TenantSecuritySettings"
    ALTER COLUMN "sessionMaxAgeMinutes" SET DEFAULT 20160;

UPDATE "TenantSecuritySettings"
    SET "sessionMaxAgeMinutes" = 20160
    WHERE "sessionMaxAgeMinutes" IS NULL;
