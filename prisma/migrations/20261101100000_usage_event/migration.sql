-- #493 — product-usage telemetry, first-party (owner, 2026-11-01: "our server,
-- per account"). No third-party analytics.
--
-- `name` is TEXT rather than a Postgres enum on purpose: the vocabulary is
-- owned by `src/app-layer/telemetry/usage-events.ts` and validated there, and a
-- DB enum would make every added event name a migration while buying nothing
-- the server-side union does not already give. Unknown names are DROPPED at
-- ingest, never stored, so the column cannot accumulate junk.
CREATE TABLE "UsageEvent" (
    "id"         TEXT         NOT NULL,
    "tenantId"   TEXT         NOT NULL,
    "userId"     TEXT         NOT NULL,
    "name"       TEXT         NOT NULL,
    "surface"    TEXT,
    "at"         TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UsageEvent_tenantId_receivedAt_idx"      ON "UsageEvent"("tenantId", "receivedAt");
CREATE INDEX "UsageEvent_tenantId_name_receivedAt_idx" ON "UsageEvent"("tenantId", "name", "receivedAt");
CREATE INDEX "UsageEvent_tenantId_userId_idx"          ON "UsageEvent"("tenantId", "userId");

ALTER TABLE "UsageEvent"
    ADD CONSTRAINT "UsageEvent_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UsageEvent"
    ADD CONSTRAINT "UsageEvent_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS in the SPLIT form. `tenantId` is NOT NULL — an event is only ever written
-- for a resolved farm — so there is no pre-resolution row to admit, and the
-- standard split is correct. Same reasoning as `GoogleOAuthState`.
ALTER TABLE "UsageEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UsageEvent" FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "UsageEvent";
CREATE POLICY tenant_isolation ON "UsageEvent"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "UsageEvent";
CREATE POLICY tenant_isolation_insert ON "UsageEvent"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- The CANONICAL form: 169 of the 187 `superuser_bypass` policies in this
-- repo spell it this way, and the two that use `app.bypass_rls` are the
-- outliers. Measured rather than recalled — I wrote the minority form first.
DROP POLICY IF EXISTS superuser_bypass ON "UsageEvent";
CREATE POLICY superuser_bypass ON "UsageEvent"
    USING (current_setting('role') != 'app_user');
