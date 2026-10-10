-- #1587: a superuser's price override is a RUN that can be cleared and restarted.
--
-- Two columns, and both are needed. The series flag answers "is an override
-- live" cheaply, which the reference-price selection and the admin form read
-- both need. The POINT flag is what makes a clear survive a re-type: the series
-- natural key (source, commodity, region, stage, currency, unit) is UNIQUE, so
-- re-typing resolves to the same row, and un-clearing the series alone would
-- republish every pre-clear point.
--
-- Nullable with no default and no backfill: every existing row is a live feed
-- series or a live manual one, and NULL already means "not cleared". No
-- existing row changes meaning, so this is additive and reversible.

ALTER TABLE "MarketPriceSeries" ADD COLUMN "clearedAt" TIMESTAMP(3);
ALTER TABLE "MarketPricePoint" ADD COLUMN "clearedAt" TIMESTAMP(3);

-- The read path filters points on `clearedAt IS NULL` within a series, so the
-- existing (seriesId, date) access stays the driver and this is a partial index
-- on the cleared minority rather than a second full index on a large table.
CREATE INDEX "MarketPricePoint_seriesId_clearedAt_idx"
    ON "MarketPricePoint" ("seriesId", "clearedAt")
    WHERE "clearedAt" IS NOT NULL;

-- Finding the live override for a commodity is the hot lookup for both the
-- reference selection and the form read.
CREATE INDEX "MarketPriceSeries_source_commodity_clearedAt_idx"
    ON "MarketPriceSeries" ("source", "commodity", "clearedAt");
