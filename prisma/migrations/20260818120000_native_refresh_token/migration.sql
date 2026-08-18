-- ═══════════════════════════════════════════════════════════════════
-- Native bearer auth — `NativeRefreshToken`
-- ═══════════════════════════════════════════════════════════════════
-- A refresh token is a CHILD of `UserSession`, not a parallel
-- credential. A bearer that could outlive an admin clicking "revoke
-- session" would be a credential the product's own security UI cannot
-- kill, so the session row is the single lineage anchor: revoking it,
-- its expiry, or the `maxConcurrentSessions` cap all invalidate every
-- token beneath it with no separate bookkeeping.
--
-- Only the SHA-256 is stored; the raw token is returned once at issue.
-- Mirrors `PasswordResetToken`, so a database disclosure yields no
-- usable credential.
-- CreateTable
CREATE TABLE "NativeRefreshToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userSessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT,
    "familyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "replacedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "NativeRefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NativeRefreshToken_tokenHash_key" ON "NativeRefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "NativeRefreshToken_tenantId_idx" ON "NativeRefreshToken"("tenantId");

-- CreateIndex
CREATE INDEX "NativeRefreshToken_userSessionId_idx" ON "NativeRefreshToken"("userSessionId");

-- CreateIndex
CREATE INDEX "NativeRefreshToken_userId_idx" ON "NativeRefreshToken"("userId");

-- CreateIndex
CREATE INDEX "NativeRefreshToken_familyId_idx" ON "NativeRefreshToken"("familyId");

-- CreateIndex
CREATE INDEX "NativeRefreshToken_expiresAt_idx" ON "NativeRefreshToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "NativeRefreshToken" ADD CONSTRAINT "NativeRefreshToken_userSessionId_fkey" FOREIGN KEY ("userSessionId") REFERENCES "UserSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════
-- RLS — the ASYMMETRIC single-policy form, mirroring Epic D.1
-- ═══════════════════════════════════════════════════════════════════
-- `tenantId` is nullable here for the same reason it is on
-- `UserSession`: a mint can precede tenant resolution.
--
-- The single-policy form is MANDATORY, not stylistic. Postgres OR's
-- permissive policies on the same command, and a permissive policy
-- without WITH CHECK implicitly grants WITH CHECK (true) on UPDATE for
-- visible rows. So a split `tenant_isolation` + `tenant_isolation_insert`
-- pair would let an `app_user`-bound session UPDATE a NULL-tenant row to
-- ANY tenantId — i.e. re-point a live refresh token at another tenant.
-- Combining the asymmetric USING (NULL OR own) with the strict
-- WITH CHECK (own) on ONE policy leaves no permissive sibling to OR with.
--
-- `NativeRefreshToken` is therefore added to SINGLE_POLICY_EXCEPTIONS in
-- tests/guardrails/rls-coverage.test.ts, whose post-loop sanity check
-- verifies this exact qual/with_check shape is real.
ALTER TABLE "NativeRefreshToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NativeRefreshToken" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation        ON "NativeRefreshToken";
DROP POLICY IF EXISTS tenant_isolation_insert ON "NativeRefreshToken";
CREATE POLICY tenant_isolation ON "NativeRefreshToken"
    USING (
        "tenantId" IS NULL
        OR "tenantId" = current_setting('app.tenant_id', true)::text
    )
    WITH CHECK (
        "tenantId" = current_setting('app.tenant_id', true)::text
    );

-- Operational bypass: issue and refresh run OUTSIDE `runInTenantContext`
-- (a refresh request is unauthenticated by construction — that is the
-- whole point), so they execute as `postgres` on the global client, the
-- same way `recordNewSession` does.
DROP POLICY IF EXISTS superuser_bypass ON "NativeRefreshToken";
CREATE POLICY superuser_bypass ON "NativeRefreshToken"
    USING (current_setting('role') != 'app_user');
