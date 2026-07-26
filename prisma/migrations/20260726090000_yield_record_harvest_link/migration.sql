-- ═══════════════════════════════════════════════════════════════════
--  HARVEST RECONCILIATION — YieldRecord.logEntryId
-- ═══════════════════════════════════════════════════════════════════
--
--  A harvest could be recorded in three places that never reconciled:
--
--    /grain/yield       → a YieldRecord and NO inventory
--    journal HARVEST    → an InventoryLot + HARVEST_IN and NO YieldRecord
--    crop-plan progress → read LogPlanting only, never a YieldRecord
--
--  So the org grain dashboard rendered totalYieldTonnes beside
--  binStoredTonnes as unrelated peers: a journal-only tenant showed zero
--  production with full bins, a yield-page-only tenant showed tonnes with
--  empty bins, and a tenant doing both showed the same physical grain
--  twice with nothing in the schema able to say so.
--
--  This column is the reconciliation link. A journal HARVEST entry can now
--  mint the YieldRecord alongside its stock lot (one farmer action, two
--  explicit effects), and `logEntryId IS NOT NULL` identifies production
--  that is ALSO represented as stock — which is what lets the dashboard
--  report the overlap instead of guessing.
--
--  Direction matters: the yield side links to the JOURNAL entry rather
--  than the lot, because `recordHarvestLot` already requires a logEntryId
--  as its provenance anchor (it is written onto StockTransaction.logEntryId
--  and LotLink.logEntryId). Linking to the entry keeps the inventory
--  ledger's single-writer discipline intact — nothing new writes stock —
--  and the lot stays reachable through that same anchor.

-- AlterTable
ALTER TABLE "YieldRecord" ADD COLUMN "logEntryId" TEXT;

-- CreateIndex
--  Idempotency: one harvest entry mints at most one yield record, so a
--  replayed journal create cannot double-count production. The column is
--  nullable ⇒ NULLS DISTINCT ⇒ the many yields typed directly on
--  /grain/yield (logEntryId IS NULL) never collide with each other.
--  logEntryId leads the index, which also satisfies the Layer-B
--  foreign-key index guardrail.
CREATE UNIQUE INDEX "YieldRecord_logEntryId_tenantId_key" ON "YieldRecord"("logEntryId", "tenantId");

-- AddForeignKey
--  Tenant-scoped composite FK, matching the planting / location / season
--  relations on this table: the pair (logEntryId, tenantId) must resolve
--  inside ONE tenant, so a cross-tenant link is impossible at the DB level
--  and not merely unlikely at the application level.
--  ON DELETE SET NULL: deleting a journal entry must not delete the
--  production figure. The yield row survives as an unlinked record — the
--  honest outcome, since the tonnage was still harvested.
ALTER TABLE "YieldRecord" ADD CONSTRAINT "YieldRecord_logEntryId_tenantId_fkey"
    FOREIGN KEY ("logEntryId", "tenantId") REFERENCES "LogEntry"("id", "tenantId")
    ON DELETE SET NULL ON UPDATE CASCADE;
