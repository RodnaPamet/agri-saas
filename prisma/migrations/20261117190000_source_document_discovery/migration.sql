-- agri-saas#3146, second slice: documents FOUND on МЗХ's listing pages.
-- Global reference data like "SourceDocumentWatch" (no tenant, no person).
CREATE TABLE "SourceDocumentDiscovery" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "series" TEXT NOT NULL,
    "listingUrl" TEXT NOT NULL,
    "title" TEXT,
    "baseline" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceDocumentDiscovery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SourceDocumentDiscovery_url_key" ON "SourceDocumentDiscovery"("url");
CREATE INDEX "SourceDocumentDiscovery_series_idx" ON "SourceDocumentDiscovery"("series");
CREATE INDEX "SourceDocumentDiscovery_notifiedAt_idx" ON "SourceDocumentDiscovery"("notifiedAt");

-- A baseline row is never announced, so it can never carry a notification.
ALTER TABLE "SourceDocumentDiscovery"
    ADD CONSTRAINT "source_document_discovery_baseline_is_silent"
    CHECK (NOT "baseline" OR "notifiedAt" IS NULL);

-- Which listings discovery has read at least once: "first read" is a fact
-- about the LISTING, not about whether any document on it matched a series.
CREATE TABLE "SourceListingRead" (
    "listingUrl" TEXT NOT NULL,
    "firstReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceListingRead_pkey" PRIMARY KEY ("listingUrl")
);
