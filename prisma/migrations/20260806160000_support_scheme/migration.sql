-- Government support schemes (ДФЗ / МЗХ / EC measures a farm APPLIES FOR).
--
-- Deliberately NOT a Framework. `/schemes` is CERTIFICATION — voluntary
-- standards a farm is AUDITED AGAINST, with requirements, controls and
-- evidence. A subsidy is a different domain object: an application window,
-- eligibility criteria and a payment, with no checklist behind it. Modelling
-- it as a Framework would put "apply by 30 Sep" next to "control point CB.7.1"
-- in one table and make both harder to read.
--
-- GLOBAL, like AgriEvent / MarketNewsItem / NewsDerivedEvent — a national
-- measure is the same fact for every tenant.
--
-- The provenance columns are mandatory, not decorative. A farmer who misses a
-- real ДФЗ window because an AI-extracted date was three days off suffers
-- direct financial harm, so: `source` distinguishes an official announcement
-- from an AI reading of a news article, `sourceExcerpt` holds the verbatim
-- sentence the dates came from, `confidence` is thresholded, and
-- `reviewStatus` starts PROPOSED — nothing reaches a tenant unreviewed.

CREATE TYPE "SupportSchemeStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED');

CREATE TABLE "SupportScheme" (
    "id"                  TEXT NOT NULL,
    "title"               TEXT NOT NULL,
    "summary"             TEXT,
    "authority"           TEXT NOT NULL,
    "measureCode"         TEXT,
    "status"              TEXT NOT NULL DEFAULT 'announced',
    "applicationOpensAt"  DATE,
    "applicationClosesAt" DATE,
    "eligibilitySummary"  TEXT,
    "budgetAmount"        DECIMAL(14,2),
    "budgetCurrency"      TEXT,
    "sourceUrl"           TEXT,
    "source"              TEXT NOT NULL DEFAULT 'curated',
    "sourceNewsItemId"    TEXT,
    "sourceTitle"         TEXT,
    "confidence"          DOUBLE PRECISION,
    "sourceExcerpt"       TEXT,
    "extractedAt"         TIMESTAMP(3),
    "reviewStatus"        "SupportSchemeStatus" NOT NULL DEFAULT 'PROPOSED',
    "reviewedAt"          TIMESTAMP(3),
    "reviewedBy"          TEXT,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportScheme_pkey" PRIMARY KEY ("id")
);

-- Idempotency: a weekly re-run over an overlapping lookback window must never
-- create a second row for the same (article, measure) pair. Curated rows carry
-- a NULL sourceNewsItemId, and NULLs do not collide under a Postgres unique
-- index, so hand-entered schemes are unconstrained by this.
CREATE UNIQUE INDEX "SupportScheme_sourceNewsItemId_measureCode_key"
    ON "SupportScheme" ("sourceNewsItemId", "measureCode");

-- Backs both reads: the admin review queue (PROPOSED) and the farmer-facing
-- list (APPROVED), each ordered by closing date.
CREATE INDEX "SupportScheme_reviewStatus_applicationClosesAt_idx"
    ON "SupportScheme" ("reviewStatus", "applicationClosesAt");
CREATE INDEX "SupportScheme_authority_applicationClosesAt_idx"
    ON "SupportScheme" ("authority", "applicationClosesAt");
