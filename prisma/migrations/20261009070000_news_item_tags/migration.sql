-- Inclusive topic + crop tags on the aggregated news feed (#231).
--
-- Purely additive: a text array defaulting to empty, so every existing row
-- reads as "no tags yet" rather than needing a backfill to be queryable. The
-- backfill is a separate step and is bounded by construction — RETENTION_DAYS
-- is 60, so the table holds at most two months of items from four feeds.
--
-- SEPARATE from `category`, which stays. `category` is exclusive and
-- priority-ordered (policy beats market) because one column forced a choice;
-- tags remove the forcing, so a subsidy story about wheat carries BOTH
-- `subsidies` and `wheat`. Dropping `category` would be a breaking change for
-- a field the web filters on and the iOS client decodes as required, so it is
-- left alone until both clients filter on tags.
--
-- The GIN index is not optional. `tags && ARRAY[...]` is array containment,
-- which a btree cannot serve, so without it the tag filter degrades to a
-- sequential scan — and a filter that is merely SLOW reads as working, which
-- is harder to notice than one that fails.
ALTER TABLE "MarketNewsItem" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE INDEX "MarketNewsItem_tags_idx" ON "MarketNewsItem" USING GIN ("tags");
