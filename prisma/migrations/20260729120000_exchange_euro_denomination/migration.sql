-- Exchange: finish the euro migration (convert, do not relabel).
--
-- The map hardcoded "€/t" onto every price chip while the listing card beside
-- it rendered the row's stored currency, so a 320 BGN offer read "320 €/t" on
-- the map and "320 BGN/t" in the card — the same number under two labels that
-- are ~1.96x apart in real value.
--
-- This converts the stored amounts instead. 1.95583 BGN = 1 EUR is not a
-- market quote: the lev has been pegged at exactly that rate since 1999 and
-- euro adoption uses it as the IRREVOCABLE conversion rate. Applying a fixed
-- rate is exact arithmetic, which is what makes a one-shot data migration a
-- safe answer here at all. Rounded to 2 dp — the column's own precision.
--
-- NULL-priced BGN rows ("market / negotiable") carry no amount to convert;
-- ROUND(NULL / …) is NULL, so they are simply relabelled, which is correct.
--
-- USD is DELIBERATELY untouched. It floats, so there is no rate this migration
-- could apply that would still be true tomorrow. Those rows keep their amount
-- and their label, and the application excludes them from every cross-listing
-- aggregate (src/lib/exchange/currency.ts).
UPDATE "ExchangeListing"
SET "pricePerTonne" = ROUND("pricePerTonne" / 1.95583, 2),
    "priceCurrency" = 'EUR'
WHERE "priceCurrency" = 'BGN';

-- New rows are euro-denominated at the storage layer too, so a writer that
-- somehow bypasses the Zod schema still lands in the marketplace currency
-- rather than silently reintroducing a second denomination.
ALTER TABLE "ExchangeListing" ALTER COLUMN "priceCurrency" SET DEFAULT 'EUR';
