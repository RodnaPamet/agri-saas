-- #3146 — the citation watch registry (first slice of agrent-ios#639).
--
-- A NEW TABLE, so nothing existing is touched and no backfill is needed: the
-- job mints a row the first time it reads a cited document, and a baseline
-- has to be bytes we actually read rather than a value invented here.
--
-- No inverse script is needed: `destructive-migration-has-inverse` derives
-- its population from DROP TABLE / DROP COLUMN / DROP TYPE / RENAME, and a
-- new table breaks no previous image — the old code simply never selects it.
--
-- ── NO ROW-LEVEL SECURITY, deliberately ──
--
-- The table carries no `tenantId`, so the DMMF auto-enroller in
-- src/lib/db/rls-middleware.ts leaves it out of TENANT_SCOPED_MODELS and
-- `rls-coverage` does not require a policy for it. That is the same posture
-- as `MarketPriceSeries` / `SoilSample` / `Unit`: a cited publication is
-- public reference data, identical for every farm. There is no per-tenant
-- filter to write because there is no tenant axis to filter on.
CREATE TABLE "SourceDocumentWatch" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "citation" TEXT NOT NULL,
    "publisher" TEXT NOT NULL,
    "series" TEXT,
    "sha256" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "contentType" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "changedAt" TIMESTAMP(3),
    "changedSha256" TEXT,
    "changedBytes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceDocumentWatch_pkey" PRIMARY KEY ("id")
);

-- The DOCUMENT is the thing with one row: two calendar citations may
-- legitimately name one URL, and watching it twice would report one revision
-- as two.
CREATE UNIQUE INDEX "SourceDocumentWatch_url_key" ON "SourceDocumentWatch"("url");

-- The flagged set is the query a review surface runs, and it is a tiny
-- fraction of the table.
CREATE INDEX "SourceDocumentWatch_changedAt_idx" ON "SourceDocumentWatch"("changedAt");
CREATE INDEX "SourceDocumentWatch_series_idx" ON "SourceDocumentWatch"("series");

-- A flag must never be mistakable for a baseline: `changedSha256` and
-- `changedBytes` are meaningful only alongside `changedAt`, and a row
-- carrying one without the others would read as "changed, hash unknown" —
-- which the job would then compare against on its next run and treat as a
-- fresh change every day. Enforced here rather than in the job because the
-- job is not the only thing that could ever write this table.
ALTER TABLE "SourceDocumentWatch"
    ADD CONSTRAINT "source_document_watch_flag_is_complete"
    CHECK (
        ("changedAt" IS NULL AND "changedSha256" IS NULL AND "changedBytes" IS NULL)
        OR ("changedAt" IS NOT NULL AND "changedSha256" IS NOT NULL AND "changedBytes" IS NOT NULL)
    );
