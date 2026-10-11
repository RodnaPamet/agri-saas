-- #1423: a ledger for the platform's OWN AI spend, so there is something to cap.
--
-- Three global jobs spend real money with no ceiling. They cannot use
-- `AiUsageEvent`: its `tenantId` is NOT NULL with an FK to `Tenant`, and a
-- platform job has no tenant. Making that column nullable would weaken the
-- invariant the per-tenant budget gate reads, so this is a separate table —
-- the same shape as `MarketPriceSeries`, which is tenant-less for the same
-- reason.
--
-- NO row level security, deliberately: there is no `tenantId` to scope by, and
-- these rows are never read under `app_user`. The writers use the global Prisma
-- client because they have no tenant context to enter with, and the cap read is
-- platform-wide by definition. A tenant-facing surface would need an aggregate,
-- not the rows.
--
-- Purely additive: a new table, nothing altered, no backfill. Recording starts
-- empty, which is correct — a cap asserted against an empty month allows
-- everything, so enabling the ledger cannot refuse work that previously ran.

CREATE TABLE "PlatformAiUsageEvent" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL,
    "completionTokens" INTEGER NOT NULL,
    "totalTokens" INTEGER NOT NULL,
    "costMicros" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAiUsageEvent_pkey" PRIMARY KEY ("id")
);

-- The cap read is SUM(totalTokens) over the current UTC month, so the index
-- leads with the column that bounds it.
CREATE INDEX "PlatformAiUsageEvent_createdAt_idx" ON "PlatformAiUsageEvent"("createdAt");
