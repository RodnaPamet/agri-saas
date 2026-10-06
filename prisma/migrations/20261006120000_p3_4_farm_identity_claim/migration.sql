-- P3.4 — FarmIdentityClaim: claiming a farm by its ЕИК.
--
-- Table ships before anything writes to it (expand-and-contract, see
-- docs/deployment.md), so the claim usecase and route land in a later PR
-- against a column set that is already in production.

-- ── 1. the lifecycle ──────────────────────────────────────────────────────
CREATE TYPE "FarmIdentityClaimStatus" AS ENUM ('PENDING', 'VERIFIED', 'DISPUTED', 'REJECTED');

-- ── 2. the table ──────────────────────────────────────────────────────────
--
-- `eikHash` is a blind index, never the plaintext ЕИК: HMAC-SHA256 under
-- LOOKUP_HMAC_KEY with its own HKDF info (`LookupKind = 'eik'`), 64 hex
-- characters. See prisma/schema/farm-identity.prisma for why the plaintext is
-- deliberately absent.
CREATE TABLE "FarmIdentityClaim" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eikHash" TEXT NOT NULL,
    "status" "FarmIdentityClaimStatus" NOT NULL DEFAULT 'PENDING',
    "claimedByUserId" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "disputedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FarmIdentityClaim_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FarmIdentityClaim_tenantId_idx" ON "FarmIdentityClaim" ("tenantId");
CREATE INDEX "FarmIdentityClaim_eikHash_idx" ON "FarmIdentityClaim" ("eikHash");

-- ── 3. at most one VERIFIED claim per ЕИК ─────────────────────────────────
--
-- PARTIAL, so PENDING and DISPUTED rows may pile up on one ЕИК while exactly
-- one may be VERIFIED. Prisma cannot express a partial unique index in the
-- schema language, which is the only reason this is hand-written SQL rather
-- than an `@@unique`.
--
-- THE DATABASE OWNS THIS, NOT THE USECASE. RLS scopes reads to the calling
-- tenant, so a pre-insert "is this ЕИК already claimed?" query run as
-- `app_user` returns ZERO rows precisely when the incumbent belongs to another
-- farm — i.e. in the only case that matters. The check would pass, the insert
-- would succeed, and one ЕИК would be verified for two farms with nothing
-- having failed. A unique index is enforced on the heap, beneath the policies,
-- so it sees the conflict the query cannot.
--
-- It is also what makes the race safe. Two claims arriving together both pass
-- any read-based check, because neither is committed when the other looks; only
-- the constraint serialises them. `tests/integration/farm-identity-claim-unique.test.ts`
-- drives that with two real concurrent connections rather than sequentially,
-- because a sequential test cannot distinguish this index from a pre-check.
CREATE UNIQUE INDEX "FarmIdentityClaim_eikHash_verified_key"
    ON "FarmIdentityClaim" ("eikHash")
    WHERE "status" = 'VERIFIED';

-- ── 4. a claim is visible to its own farm only ────────────────────────────
--
-- The enumeration requirement in P3.4 ("identical responses whatever the
-- state") is a property of the ROUTE, but it rests on this: if a tenant could
-- read another tenant's claims, no amount of response shaping would hide who
-- holds an ЕИК. So the policy is the floor and the route is the finish.
--
-- Scoped by `app.tenant_id` and NOT by `app.actor_user_id`: a claim belongs to
-- the farm, not to the person who typed it. A colleague must be able to see a
-- pending claim — otherwise the only person who can chase a verification is
-- whoever happened to submit it, and a farm whose submitter leaves can neither
-- see nor resubmit its own claim.
ALTER TABLE "FarmIdentityClaim" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FarmIdentityClaim" FORCE ROW LEVEL SECURITY;

-- The canonical three-policy shape from
-- prisma/migrations/20260422180000_enable_rls_coverage/migration.sql, and the
-- names are load-bearing: `tests/guardrails/rls-coverage.test.ts` demands
-- `tenant_isolation`, `tenant_isolation_insert` and `superuser_bypass` BY NAME
-- against live `pg_policies`. A policy with the right predicate and a
-- descriptive name of its own reads fine and fails that guardrail — which is
-- how this migration was written the first time.
--
-- `tenant_isolation` carries USING only. With WITH CHECK unspecified on an ALL
-- policy, the USING predicate doubles as WITH CHECK for UPDATE, so a tenant
-- cannot move an existing claim to another farm either.
CREATE POLICY tenant_isolation ON "FarmIdentityClaim"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

-- Required BY NAME by `tests/guardrails/rls-coverage.test.ts`, and belt-and-
-- braces rather than the sole INSERT protection.
--
-- An earlier version of this comment claimed USING is not consulted on INSERT,
-- so that without this policy `app_user` could plant a claim in another farm.
-- That is false, and dropping this policy in isolation against the live
-- database proved it: the foreign-attribution insert was still refused and the
-- own-tenant insert still succeeded. On a `FOR ALL` policy with WITH CHECK
-- unspecified, Postgres uses the USING expression as the check for new rows —
-- for INSERT as well as UPDATE. `tenant_isolation` above therefore already
-- covers attribution on its own.
--
-- It stays because the guardrail demands the name, and because relying on that
-- doubling means any future edit narrowing `tenant_isolation` to
-- `FOR SELECT` — a plausible, innocent-looking change — would silently remove
-- INSERT protection with nothing to catch it. An explicit policy makes the
-- INSERT rule survive that edit.
CREATE POLICY tenant_isolation_insert ON "FarmIdentityClaim"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- The staff verification console (P3.9) does not run as `app_user`. A reviewer
-- has to see across tenants by definition, and that is exactly the privilege
-- `app_user` must not have.
CREATE POLICY superuser_bypass ON "FarmIdentityClaim"
    USING (current_setting('role') != 'app_user');
