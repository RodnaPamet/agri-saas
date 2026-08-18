-- ═══════════════════════════════════════════════════════════════════
-- Native OAuth handoff — `NativeAuthCode`
-- ═══════════════════════════════════════════════════════════════════
-- Google refuses OAuth inside embedded webviews, so a native client signs
-- in via the SYSTEM browser — which cannot set a cookie the app's webview
-- can read. A short-lived, single-use, PKCE-bound code is what crosses
-- that boundary, and it is the ONLY thing that crosses.
-- CreateTable
CREATE TABLE "NativeAuthCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "userSessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT,
    "codeChallenge" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "NativeAuthCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NativeAuthCode_codeHash_key" ON "NativeAuthCode"("codeHash");

-- CreateIndex
CREATE INDEX "NativeAuthCode_tenantId_idx" ON "NativeAuthCode"("tenantId");

-- CreateIndex
CREATE INDEX "NativeAuthCode_userSessionId_idx" ON "NativeAuthCode"("userSessionId");

-- CreateIndex
CREATE INDEX "NativeAuthCode_userId_idx" ON "NativeAuthCode"("userId");

-- CreateIndex
CREATE INDEX "NativeAuthCode_expiresAt_idx" ON "NativeAuthCode"("expiresAt");

-- AddForeignKey
ALTER TABLE "NativeAuthCode" ADD CONSTRAINT "NativeAuthCode_userSessionId_fkey" FOREIGN KEY ("userSessionId") REFERENCES "UserSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════
-- RLS — asymmetric single policy, same form as UserSession (Epic D.1)
-- ═══════════════════════════════════════════════════════════════════
-- `tenantId` is nullable, inherited from the session. The single-policy
-- form is mandatory: Postgres OR's permissive policies, and a permissive
-- policy without WITH CHECK implicitly grants WITH CHECK (true) on UPDATE
-- for visible rows — so a split tenant_isolation_insert would let an
-- `app_user`-bound session re-point a LIVE authorization code at another
-- tenant. Registered in SINGLE_POLICY_EXCEPTIONS.
ALTER TABLE "NativeAuthCode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NativeAuthCode" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation        ON "NativeAuthCode";
DROP POLICY IF EXISTS tenant_isolation_insert ON "NativeAuthCode";
CREATE POLICY tenant_isolation ON "NativeAuthCode"
    USING (
        "tenantId" IS NULL
        OR "tenantId" = current_setting('app.tenant_id', true)::text
    )
    WITH CHECK (
        "tenantId" = current_setting('app.tenant_id', true)::text
    );

-- Issue and exchange run OUTSIDE runInTenantContext — the exchange is
-- unauthenticated by construction, which is the point — so they execute
-- as `postgres`, like `recordNewSession`.
DROP POLICY IF EXISTS superuser_bypass ON "NativeAuthCode";
CREATE POLICY superuser_bypass ON "NativeAuthCode"
    USING (current_setting('role') != 'app_user');
