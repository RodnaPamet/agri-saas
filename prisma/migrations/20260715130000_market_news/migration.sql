-- Market-news backbone — GLOBAL, tenant-agnostic agri-news cache.
--
-- MarketNewsItem carries NO tenantId (public news headlines aggregated from
-- third-party RSS/Atom feeds) — identical for every tenant, exactly like
-- "MarketPriceSeries" / "SoilSample" / "CadastreArchive". Because it has no
-- tenantId it is excluded from TENANT_SCOPED_MODELS and carries NO row-level-
-- security policy.
--
-- LEGAL: only title + short snippet (~300 chars) + source + link are stored,
-- and the UI always links OUT to the publisher. No full-text republication.

-- CreateTable
CREATE TABLE "MarketNewsItem" (
    "id" TEXT NOT NULL,
    "feedSource" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "snippet" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "urlHash" TEXT NOT NULL,
    "imageUrl" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketNewsItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: idempotent-upsert dedupe key (sha256 of the article url).
CREATE UNIQUE INDEX "MarketNewsItem_urlHash_key" ON "MarketNewsItem"("urlHash");

-- CreateIndex: newest-first list read + retention prune sort key.
CREATE INDEX "MarketNewsItem_publishedAt_idx" ON "MarketNewsItem"("publishedAt");
