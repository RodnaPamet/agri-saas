-- Exchange messaging — a seller refusing further contact from one tenant.

CREATE TABLE "ExchangeBlock" (
    "id"              TEXT NOT NULL,
    "sellerTenantId"  TEXT NOT NULL,
    "blockedTenantId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExchangeBlock_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExchangeBlock_sellerTenantId_blockedTenantId_key"
    ON "ExchangeBlock"("sellerTenantId", "blockedTenantId");
CREATE INDEX "ExchangeBlock_blockedTenantId_idx" ON "ExchangeBlock"("blockedTenantId");

ALTER TABLE "ExchangeBlock" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExchangeBlock" FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS exchange_block_select ON "ExchangeBlock";
DROP POLICY IF EXISTS exchange_block_insert ON "ExchangeBlock";
DROP POLICY IF EXISTS exchange_block_delete ON "ExchangeBlock";
DROP POLICY IF EXISTS exchange_block_update ON "ExchangeBlock";
DROP POLICY IF EXISTS superuser_bypass      ON "ExchangeBlock";

-- SELECT is the wide one, deliberately: the block is ENFORCED while running in
-- the BLOCKED tenant's context (their own open/send is what must be refused),
-- so a row they cannot see cannot refuse them. They see only rows naming them.
CREATE POLICY exchange_block_select ON "ExchangeBlock"
    FOR SELECT
    USING (
        "sellerTenantId"  = current_setting('app.tenant_id', true)::text
        OR "blockedTenantId" = current_setting('app.tenant_id', true)::text
    );

-- Everything that CHANGES a block is the seller's alone. Written as separate
-- policies rather than one USING clause: a single policy's USING governs
-- DELETE as well as SELECT, so the wide read above would have let a blocked
-- tenant delete the row and unblock itself.
CREATE POLICY exchange_block_insert ON "ExchangeBlock"
    FOR INSERT
    WITH CHECK ("sellerTenantId" = current_setting('app.tenant_id', true)::text);

CREATE POLICY exchange_block_delete ON "ExchangeBlock"
    FOR DELETE
    USING ("sellerTenantId" = current_setting('app.tenant_id', true)::text);

CREATE POLICY exchange_block_update ON "ExchangeBlock"
    FOR UPDATE
    USING ("sellerTenantId" = current_setting('app.tenant_id', true)::text)
    WITH CHECK ("sellerTenantId" = current_setting('app.tenant_id', true)::text);

CREATE POLICY superuser_bypass ON "ExchangeBlock"
    USING (current_setting('role') != 'app_user');
