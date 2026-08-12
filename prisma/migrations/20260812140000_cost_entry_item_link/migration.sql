-- ═══════════════════════════════════════════════════════════════════
--  CostEntry.itemId — the PRODUCT a cost bought.
--
--  A sixth domain link. The inventory surface had no honest one: a
--  cost's nearest column was `locationId`, which is where a lot SITS
--  rather than what was purchased, so an input cost could only ever be
--  shown against a field.
--
--  Purely additive — a nullable column, its index and its FK. Nothing is
--  dropped or renamed, so the previous image keeps working and no
--  deploy/rollback inverse script is required.
--
--  This does NOT change what reaches crop cost. Crop cost is
--  CONSUMPTION-based; an INPUT-category CostEntry remains a purchase that
--  feeds cash-out only. The link is what lets a product page SHOW its
--  purchases beside its consumption — not what merges them.
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE "CostEntry" ADD COLUMN "itemId" TEXT;

-- CreateIndex
--  Its own [tenantId, fk] composite, like every other link on this table:
--  Layer B's check reads group[1] and never group[2], and Postgres needs
--  it for an itemId-only filter regardless.
CREATE INDEX "CostEntry_tenantId_itemId_idx" ON "CostEntry"("tenantId", "itemId");

-- AddForeignKey
--  Composite [itemId, tenantId] → [id, tenantId]: the cross-tenant
--  barrier used throughout. A cost can never point at another tenant's
--  product, even if an id leaks.
ALTER TABLE "CostEntry" ADD CONSTRAINT "CostEntry_itemId_tenantId_fkey" FOREIGN KEY ("itemId", "tenantId") REFERENCES "Item"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
