-- #2495 step 6 — server-held state for the NATIVE Google consent flow.
--
-- The web flow keeps its HttpOnly `google_oauth_state` cookie and is untouched.
-- The phone cannot use it: its consent runs in an EPHEMERAL
-- ASWebAuthenticationSession, a different cookie jar from the one URLSession
-- put the API response's cookie in, so the callback never sees it and every
-- attempt answers `state_invalid`.
CREATE TABLE "GoogleOAuthState" (
    "id"          TEXT         NOT NULL,
    "stateHash"   TEXT         NOT NULL,
    "tenantId"    TEXT         NOT NULL,
    "userId"      TEXT         NOT NULL,
    "redirectUri" TEXT         NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"   TIMESTAMP(3) NOT NULL,
    "consumedAt"  TIMESTAMP(3),

    CONSTRAINT "GoogleOAuthState_pkey" PRIMARY KEY ("id")
);

-- UNIQUE so the callback is one indexed read, and so a replay cannot insert a
-- second row carrying the same state.
CREATE UNIQUE INDEX "GoogleOAuthState_stateHash_key" ON "GoogleOAuthState"("stateHash");
CREATE INDEX "GoogleOAuthState_tenantId_idx" ON "GoogleOAuthState"("tenantId");
CREATE INDEX "GoogleOAuthState_expiresAt_idx" ON "GoogleOAuthState"("expiresAt");

ALTER TABLE "GoogleOAuthState"
    ADD CONSTRAINT "GoogleOAuthState_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS, in the SPLIT form rather than the asymmetric single policy its siblings
-- use. `NativeAuthCode` and `NativeRefreshToken` need one policy because their
-- `tenantId` is NULLABLE — a mint can precede tenant resolution — and a split
-- INSERT policy would be a permissive sibling letting an app_user-bound session
-- re-point a live row at another tenant. Here `tenantId` is NOT NULL: the state
-- is issued by an administrator of a known farm, so there is no pre-resolution
-- row to admit and the standard split form is correct.
ALTER TABLE "GoogleOAuthState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GoogleOAuthState" FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "GoogleOAuthState";
CREATE POLICY tenant_isolation ON "GoogleOAuthState"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "GoogleOAuthState";
CREATE POLICY tenant_isolation_insert ON "GoogleOAuthState"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

-- The callback is tenant-AGNOSTIC — one registered redirect URI for every farm
-- — so it reads this table through the privileged client with no tenant
-- context, and this is the policy that admits it. The same arrangement the
-- cookie flow already relies on.
DROP POLICY IF EXISTS superuser_bypass ON "GoogleOAuthState";
CREATE POLICY superuser_bypass ON "GoogleOAuthState"
    USING (current_setting('role') != 'app_user');
