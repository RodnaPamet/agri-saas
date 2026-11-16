-- Platform-admin corrections and additions to the published agronomic
-- calendar — #3095.
--
-- TENANTLESS by design: agronomy for North Bulgaria is the same agronomy for
-- every farm there, so a per-farm override would be a different feature (a
-- farm's own adjusted plan) and must not be confused with correcting a
-- published figure.

CREATE TYPE "AgroCalendarOverrideOrigin" AS ENUM ('CORRECTED', 'ADDED');

CREATE TABLE "AgroCalendarOverride" (
    "id"         TEXT NOT NULL,
    "windowId"   TEXT NOT NULL,
    "cropKey"    TEXT NOT NULL,
    "origin"     "AgroCalendarOverrideOrigin" NOT NULL,
    "windowJson" JSONB NOT NULL,
    -- NOT NULL, which is the owner's ruling made structural: an override
    -- changes the VALUE while the published citation still points at a page
    -- that no longer supports it, so a correction with no stated basis must
    -- not be representable.
    "basisBg"    TEXT NOT NULL,
    "basisEn"    TEXT,
    "clearedAt"  TIMESTAMP(3),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,
    "authorRef"  TEXT NOT NULL,

    CONSTRAINT "AgroCalendarOverride_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AgroCalendarOverride_windowId_idx"
    ON "AgroCalendarOverride"("windowId");
CREATE INDEX IF NOT EXISTS "AgroCalendarOverride_cropKey_idx"
    ON "AgroCalendarOverride"("cropKey");
CREATE INDEX IF NOT EXISTS "AgroCalendarOverride_clearedAt_idx"
    ON "AgroCalendarOverride"("clearedAt");

-- ONE LIVE OVERRIDE PER WINDOW, and this is the half Prisma cannot express.
--
-- Cleared rows are kept, so a plain unique index would refuse a second
-- correction after the first was cleared — which is the normal case, not an
-- error. Without the constraint, two live rows on one window make the served
-- window depend on row order: the calendar would answer differently between
-- requests with nothing failing, which is the worst available outcome for a
-- surface whose whole point is that a figure is traceable.
CREATE UNIQUE INDEX IF NOT EXISTS "AgroCalendarOverride_live_windowId_key"
    ON "AgroCalendarOverride"("windowId")
    WHERE "clearedAt" IS NULL;

ALTER TABLE "AgroCalendarOverride" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgroCalendarOverride" FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS superuser_bypass ON "AgroCalendarOverride";

CREATE POLICY superuser_bypass ON "AgroCalendarOverride"
    USING (current_setting('role') != 'app_user');

-- `superuser_bypass` is the ONLY policy, following `NoticeScore`. No arm
-- grants `app_user` anything, so a tenant session sees zero rows however the
-- application changes — and that is deliberate rather than restrictive: the
-- calendar is served to a PERSON-scoped route that holds no tenant context,
-- and the loader reads overrides through the privileged client. A SELECT arm
-- for `app_user` would be a second, weaker way to reach the same rows.
--
-- The table is also NOT tenant-scoped, so `rls-coverage`'s tenant-table
-- requirement does not reach it; this policy exists so the absence of access
-- is enforced by the database rather than by the application happening not to
-- ask.
