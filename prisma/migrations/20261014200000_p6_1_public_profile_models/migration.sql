-- ═══════════════════════════════════════════════════════════════════
-- P6.1 — a farm in public: FarmBrand, PersonProfile, PublicFarmProfile
-- ═══════════════════════════════════════════════════════════════════
--
-- TABLES ONLY, deliberately. The standing rule for this phase is that
-- tables ship one release before the code that writes them, so the
-- field allowlist and the projection writer are a separate PR. Nothing
-- in src/ reads or writes these three after this migration.
--
-- THREE MODELS, THREE DIFFERENT RLS AXES. Each is argued below rather
-- than assumed, because the rls-coverage ratchet requires every model
-- to land in exactly one bucket and "nobody looked" is the failure it
-- exists to catch.
--
--   FarmBrand          tenant-scoped   → the canonical Epic D.1 pair
--   PersonProfile      no reader yet   → no policy, on the record
--   PublicFarmProfile  global          → no policy, and that IS the point
--
-- CreateTable
CREATE TABLE "FarmBrand" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "handle" TEXT,
    "displayName" TEXT,
    "tagline" TEXT,
    "about" TEXT,
    "oblast" TEXT,
    "crops" TEXT[],
    "projectedHandle" TEXT,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "consentedAt" TIMESTAMP(3),
    "consentTextVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FarmBrand_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "PersonProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" TEXT,
    "about" TEXT,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PersonProfile_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "PublicFarmProfile" (
    "handle" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "tagline" TEXT,
    "about" TEXT,
    "oblast" TEXT,
    "crops" TEXT[],
    "indexable" BOOLEAN NOT NULL DEFAULT false,
    "projectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PublicFarmProfile_pkey" PRIMARY KEY ("handle")
);
-- CreateIndex
CREATE UNIQUE INDEX "FarmBrand_tenantId_key" ON "FarmBrand"("tenantId");
-- CreateIndex
CREATE UNIQUE INDEX "FarmBrand_handle_key" ON "FarmBrand"("handle");
-- CreateIndex
CREATE INDEX "FarmBrand_oblast_idx" ON "FarmBrand"("oblast");
-- CreateIndex
CREATE INDEX "FarmBrand_published_idx" ON "FarmBrand"("published");
-- CreateIndex
CREATE UNIQUE INDEX "PersonProfile_userId_key" ON "PersonProfile"("userId");
-- CreateIndex
CREATE INDEX "PublicFarmProfile_oblast_idx" ON "PublicFarmProfile"("oblast");
-- CreateIndex
CREATE INDEX "PublicFarmProfile_indexable_idx" ON "PublicFarmProfile"("indexable");
-- AddForeignKey
ALTER TABLE "FarmBrand" ADD CONSTRAINT "FarmBrand_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "PersonProfile" ADD CONSTRAINT "PersonProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- RLS
-- ═══════════════════════════════════════════════════════════════════

-- ── FarmBrand: tenant-scoped, the canonical pair ──
--
-- The owner's private editing surface. Identical in form to every other
-- tenant-scoped table (see 20260716120000_user_interests), so it needs
-- no new argument — `TENANT_SCOPED_MODELS` is DMMF-derived and picks it
-- up from `tenantId` automatically, which is why a missing policy here
-- would be a red build rather than an oversight.
ALTER TABLE "FarmBrand" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FarmBrand" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "FarmBrand";
CREATE POLICY tenant_isolation ON "FarmBrand"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "FarmBrand";
CREATE POLICY tenant_isolation_insert ON "FarmBrand"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "FarmBrand";
CREATE POLICY superuser_bypass ON "FarmBrand"
    USING (current_setting('role') != 'app_user');

-- ── PersonProfile: NO policy, because nothing reaches it under app_user ──
--
-- No `tenantId`, so the tenant axis does not apply. I first wrote a
-- user-scoped fail-closed policy on the `app.user_id` axis, citing
-- P1.4's "defence in depth ahead of the code". That was the wrong
-- precedent, and the difference is worth recording.
--
-- P1.4 narrowed tables that ALREADY HAD a dangerous policy: the
-- null-tenant arm on `UserSession` was unconditional, so under
-- `app_user` any session could read every null-tenant row. There was a
-- live over-permission to close.
--
-- `PersonProfile` has no policy and, measured 2026-10-14, no reader of
-- any kind — this migration ships the table and the writer comes in a
-- later release. That is the `User` / `Tenant` / `FeatureFlag`
-- situation, not the `UserSession` one, and
-- `NO_RLS_NOT_APP_USER_MODELS` is the bucket those 16 models sit in
-- with exactly this reason.
--
-- So the policy belongs to the FIRST PR that routes a person-scoped
-- read through `app_user` — P6.6's editor or P6.9's iOS profile view —
-- which is also the only PR that can write the integration test with
-- real negative controls for it. Adding an inert policy now would mean
-- asserting isolation that no test could exercise, and a control that
-- cannot express failure is green for ever.
--
-- The classification entry records this so it is a decision on the
-- record rather than an omission, which is what the ratchet exists to
-- distinguish.

-- ── PublicFarmProfile: NO policy, and the absence is the design ──
--
-- Cross-tenant readability IS the product here, the same argument
-- `ExchangeListing` already carries: a public profile only its own farm
-- can read is not a public profile. So it is classified in
-- `GLOBAL_BY_DESIGN_MODELS` and deliberately carries no RLS.
--
-- Two things make that safe, and neither is discipline:
--
--   1. THE TABLE HAS NO PII COLUMNS. `egn`, `eik`, `address`,
--      `municipality` and `settlement` live on `FarmProfile` and do not
--      exist here, so a projection writer cannot leak them by
--      forgetting an allowlist entry — there is nowhere for the value
--      to land. P6.10's "0 hits" hardening test is structurally
--      satisfied for anything read from this table.
--   2. WRITES DO NOT COME FROM A TENANT. The projection is written by
--      the allowlist path under the global client, never by a tenant
--      session, so there is no write surface for RLS to constrain.
--
-- `FORCE ROW LEVEL SECURITY` is NOT set for the same reason: there is
-- no policy to force, and setting it without one would make the table
-- unreadable under `app_user` — which reads as isolation but would
-- actually be an outage of the public page the moment any path entered
-- `app_user`.
