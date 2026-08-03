-- Canonical commodity taxonomy: add a stable key alongside the free-text
-- `commodity` so listings unify + group across spellings/languages.

-- AlterTable
ALTER TABLE "ExchangeListing" ADD COLUMN "commodityKey" TEXT;

-- Backfill existing rows: map known seed commodities (case-insensitive, both
-- locales) to their canonical key; everything else becomes the OTHER long tail.
UPDATE "ExchangeListing" SET "commodityKey" = 'WHEAT'     WHERE lower("commodity") IN ('wheat', 'пшеница');
UPDATE "ExchangeListing" SET "commodityKey" = 'MAIZE'     WHERE lower("commodity") IN ('maize', 'царевица');
UPDATE "ExchangeListing" SET "commodityKey" = 'SUNFLOWER' WHERE lower("commodity") IN ('sunflower', 'слънчоглед');
UPDATE "ExchangeListing" SET "commodityKey" = 'BARLEY'    WHERE lower("commodity") IN ('barley', 'ечемик');
UPDATE "ExchangeListing" SET "commodityKey" = 'RAPESEED'  WHERE lower("commodity") IN ('rapeseed', 'рапица');
UPDATE "ExchangeListing" SET "commodityKey" = 'OATS'      WHERE lower("commodity") IN ('oats', 'овес');
UPDATE "ExchangeListing" SET "commodityKey" = 'RYE'       WHERE lower("commodity") IN ('rye', 'ръж');
UPDATE "ExchangeListing" SET "commodityKey" = 'SOYBEAN'   WHERE lower("commodity") IN ('soybean', 'соя');
UPDATE "ExchangeListing" SET "commodityKey" = 'PEAS'      WHERE lower("commodity") IN ('peas', 'грах');
UPDATE "ExchangeListing" SET "commodityKey" = 'LENTILS'   WHERE lower("commodity") IN ('lentils', 'леща');
UPDATE "ExchangeListing" SET "commodityKey" = 'OTHER'     WHERE "commodityKey" IS NULL;
