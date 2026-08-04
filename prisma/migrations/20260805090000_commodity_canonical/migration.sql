-- Canonical commodity join key across the surfaces that name a commodity.
--
-- Trends was a read-only island because four vocabularies disagreed — the
-- lowercase TrendCommodity enum, free-text listing commodity, free-text
-- contract commodity, and the tenant crop catalogue — so there was no join
-- key and "am I selling above or below market?" was UNBUILDABLE, not merely
-- unbuilt.
--
-- The free-text columns are KEPT. "Malting Barley" is not "Barley", and that
-- distinction is commercially real; it is what the farmer read off the paper
-- contract. The canonical slug lives beside it as a derived key.

ALTER TABLE "Contract"    ADD COLUMN "commodityCanonical" TEXT;
ALTER TABLE "YieldRecord" ADD COLUMN "commodityCanonical" TEXT;
ALTER TABLE "CropType"    ADD COLUMN "commodityCanonical" TEXT;

-- ── Backfill ────────────────────────────────────────────────────────────
--
-- Mirrors foldForLookup() in src/lib/market/commodity-vocabulary.ts:
-- lowercase, then strip whitespace and the . _ / \ - separators. The alias
-- list below MUST stay in step with COMMODITY_ALIASES there; a value missing
-- here simply stays null, which is the safe direction (no false join).
--
-- Postgres lower() is locale-invariant for ASCII and correct for Cyrillic,
-- so the Bulgarian aliases fold the same way they do in TypeScript.

-- The alias list is repeated per statement as an inline CTE rather than a
-- temp table: Prisma runs a migration's statements without a wrapping
-- transaction, so a `TEMP ... ON COMMIT DROP` table disappears before the
-- UPDATEs that need it.
--
-- It MUST stay in step with COMMODITY_ALIASES in
-- src/lib/market/commodity-vocabulary.ts. A value missing here just leaves
-- null, which is the safe direction — no false join.

WITH alias(folded, canonical) AS (VALUES
    ('wheat','wheat'), ('commonwheat','wheat'), ('softwheat','wheat'),
    ('durum','wheat'), ('durumwheat','wheat'), ('пшеница','wheat'),
    ('maize','maize'), ('corn','maize'), ('царевица','maize'),
    ('barley','barley'), ('ечемик','barley'),
    ('sunflower','sunflower'), ('sunflowerseed','sunflower'), ('слънчоглед','sunflower'),
    ('rapeseed','rapeseed'), ('canola','rapeseed'), ('рапица','rapeseed'),
    ('oats','oats'), ('oat','oats'), ('овес','oats'),
    ('rye','rye'), ('ръж','rye'),
    ('soybean','soybean'), ('soybeans','soybean'), ('soya','soybean'), ('соя','soybean'),
    ('peas','peas'), ('pea','peas'), ('грах','peas'),
    ('lentils','lentils'), ('lentil','lentils'), ('леща','lentils')
)
UPDATE "Contract" c
SET "commodityCanonical" = alias.canonical
FROM alias
WHERE c."commodity" IS NOT NULL
  AND lower(regexp_replace(c."commodity", '[[:space:]._/\\-]+', '', 'g')) = alias.folded;

WITH alias(folded, canonical) AS (VALUES
    ('wheat','wheat'), ('commonwheat','wheat'), ('softwheat','wheat'),
    ('durum','wheat'), ('durumwheat','wheat'), ('пшеница','wheat'),
    ('maize','maize'), ('corn','maize'), ('царевица','maize'),
    ('barley','barley'), ('ечемик','barley'),
    ('sunflower','sunflower'), ('sunflowerseed','sunflower'), ('слънчоглед','sunflower'),
    ('rapeseed','rapeseed'), ('canola','rapeseed'), ('рапица','rapeseed'),
    ('oats','oats'), ('oat','oats'), ('овес','oats'),
    ('rye','rye'), ('ръж','rye'),
    ('soybean','soybean'), ('soybeans','soybean'), ('soya','soybean'), ('соя','soybean'),
    ('peas','peas'), ('pea','peas'), ('грах','peas'),
    ('lentils','lentils'), ('lentil','lentils'), ('леща','lentils')
)
UPDATE "YieldRecord" y
SET "commodityCanonical" = alias.canonical
FROM alias
WHERE y."commodity" IS NOT NULL
  AND lower(regexp_replace(y."commodity", '[[:space:]._/\\-]+', '', 'g')) = alias.folded;

WITH alias(folded, canonical) AS (VALUES
    ('wheat','wheat'), ('commonwheat','wheat'), ('softwheat','wheat'),
    ('durum','wheat'), ('durumwheat','wheat'), ('пшеница','wheat'),
    ('maize','maize'), ('corn','maize'), ('царевица','maize'),
    ('barley','barley'), ('ечемик','barley'),
    ('sunflower','sunflower'), ('sunflowerseed','sunflower'), ('слънчоглед','sunflower'),
    ('rapeseed','rapeseed'), ('canola','rapeseed'), ('рапица','rapeseed'),
    ('oats','oats'), ('oat','oats'), ('овес','oats'),
    ('rye','rye'), ('ръж','rye'),
    ('soybean','soybean'), ('soybeans','soybean'), ('soya','soybean'), ('соя','soybean'),
    ('peas','peas'), ('pea','peas'), ('грах','peas'),
    ('lentils','lentils'), ('lentil','lentils'), ('леща','lentils')
)
UPDATE "CropType" ct
SET "commodityCanonical" = alias.canonical
FROM alias
WHERE lower(regexp_replace(ct."name", '[[:space:]._/\\-]+', '', 'g')) = alias.folded;

-- Also normalise exchange listings written before the write schema was
-- constrained. Unlike the columns above, ExchangeListing.commodity IS the
-- trading category buyers filter on, and the create form only ever offered a
-- fixed list — so canonical-in-place is correct there.
WITH alias(folded, canonical) AS (VALUES
    ('wheat','wheat'), ('commonwheat','wheat'), ('softwheat','wheat'),
    ('durum','wheat'), ('durumwheat','wheat'), ('пшеница','wheat'),
    ('maize','maize'), ('corn','maize'), ('царевица','maize'),
    ('barley','barley'), ('ечемик','barley'),
    ('sunflower','sunflower'), ('sunflowerseed','sunflower'), ('слънчоглед','sunflower'),
    ('rapeseed','rapeseed'), ('canola','rapeseed'), ('рапица','rapeseed'),
    ('oats','oats'), ('oat','oats'), ('овес','oats'),
    ('rye','rye'), ('ръж','rye'),
    ('soybean','soybean'), ('soybeans','soybean'), ('soya','soybean'), ('соя','soybean'),
    ('peas','peas'), ('pea','peas'), ('грах','peas'),
    ('lentils','lentils'), ('lentil','lentils'), ('леща','lentils')
)
UPDATE "ExchangeListing" l
SET "commodity" = alias.canonical
FROM alias
WHERE lower(regexp_replace(l."commodity", '[[:space:]._/\\-]+', '', 'g')) = alias.folded
  AND l."commodity" <> alias.canonical;

-- ── Indexes ─────────────────────────────────────────────────────────────
-- Tenant-leading composites: every read of these is inside one tenant, and
-- the schema-index guardrail (Layer A) requires a tenantId-leading index on
-- a tenant-scoped model.
CREATE INDEX "Contract_tenantId_commodityCanonical_idx"
    ON "Contract" ("tenantId", "commodityCanonical");
CREATE INDEX "YieldRecord_tenantId_commodityCanonical_idx"
    ON "YieldRecord" ("tenantId", "commodityCanonical");
CREATE INDEX "CropType_tenantId_commodityCanonical_idx"
    ON "CropType" ("tenantId", "commodityCanonical");

-- ── MarketPriceSeries identity includes denomination ────────────────────
--
-- currency + unit were outside the natural key and written ONLY on create,
-- so an upstream denomination change appended new-currency points to the old
-- series under the old label: a BGN price rendered as EUR, mixed into a EUR
-- history, on one axis, with no error anywhere. It happened, and was
-- remediated by hand-written SQL.
--
-- Widening the key is safe for existing rows — they were already unique under
-- the narrower one — and makes a future change MINT A NEW SERIES instead, so
-- historical points keep the denomination they were actually quoted in.
DROP INDEX IF EXISTS "MarketPriceSeries_source_commodity_region_stage_key";
CREATE UNIQUE INDEX "MarketPriceSeries_source_commodity_region_stage_currency_unit_key"
    ON "MarketPriceSeries" ("source", "commodity", "region", "stage", "currency", "unit");
