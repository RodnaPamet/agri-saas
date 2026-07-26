-- ═══════════════════════════════════════════════════════════════════
--  MOISTURE BASIS — YieldRecord.netTonnesStd (database-generated)
-- ═══════════════════════════════════════════════════════════════════
--
--  `moisturePct` was stored, displayed, and used in ZERO calculations. So
--  90 t at 18% moisture and 90 t at 13.5% were summed into one season
--  total, ranked against each other in t/ha tables, and printed side by
--  side in the year-end PDF as if they were the same quantity of grain.
--  They are not: the wetter load carries ~4.5% more water and
--  correspondingly less sellable dry matter. In a product where trade
--  settles at a standard basis, that is a measurement error.
--
--  This column expresses every tonnage at one basis (14.0%, the EU /
--  Bulgarian cereal delivery standard), derived from the invariant that
--  water is the only thing being removed:
--
--      dry mass         = gross × (100 − m) / 100
--      mass at standard = dry mass / ((100 − 14) / 100)
--                       = gross × (100 − m) / 86
--
--  ─── Why GENERATED and not application-maintained ─────────────────
--
--  A derived tonnage written by application code drifts the moment any
--  write path forgets to recompute it — and this one has three (the yield
--  form, the journal-harvest mint, and any future import). Postgres
--  recomputes a generated column on every insert and update of its inputs,
--  so drift is not merely unlikely, it is unrepresentable.
--
--  Being a real stored column also keeps it SUM()-able. The portfolio
--  rollups are pure in-DB aggregates by design; normalising in application
--  code would have meant loading rows to do arithmetic the database can do
--  in the aggregate, which is exactly the shape the recap is being moved
--  AWAY from in this same change.
--
--  ─── NULL semantics ───────────────────────────────────────────────
--
--  NULL when moisturePct is NULL. That is deliberate and load-bearing: a
--  record with no moisture reading has no comparable weight, and
--  COALESCE-ing it to the standard would silently re-mix the bases this
--  column exists to separate. Readers sum this column for the comparable
--  total and report the unadjusted remainder separately, so an operator can
--  see how much of a figure is normalised.
--
--  Readings outside 0–40% are refused at the API boundary
--  (`MoisturePercent` in grain.schemas.ts). Historic rows can still hold
--  them, so the expression clamps rather than emitting a negative tonnage:
--  a nonsensical stored moisture yields NULL, not a number that would
--  quietly drag a season total down.

ALTER TABLE "YieldRecord"
    ADD COLUMN "netTonnesStd" DECIMAL(14,3)
    GENERATED ALWAYS AS (
        CASE
            WHEN "grossTonnes" IS NULL THEN NULL
            WHEN "moisturePct" IS NULL THEN NULL
            WHEN "moisturePct" < 0 OR "moisturePct" > 40 THEN NULL
            WHEN "grossTonnes" < 0 THEN NULL
            ELSE ROUND("grossTonnes" * (100 - "moisturePct") / 86, 3)
        END
    ) STORED;

-- The season / portfolio rollups sum this per season, alongside the
-- existing (tenantId, seasonId) index that already serves the grouping.
CREATE INDEX "YieldRecord_tenantId_seasonId_netTonnesStd_idx"
    ON "YieldRecord"("tenantId", "seasonId", "netTonnesStd");
