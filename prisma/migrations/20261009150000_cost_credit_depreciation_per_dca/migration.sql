-- ═══════════════════════════════════════════════════════════════════
--  COST CALCULATOR — two overhead categories, and the rate as entered
-- ═══════════════════════════════════════════════════════════════════
--
--  Owner decisions, 2026-10-09, for the «Нов разход» sheet: overheads are
--  salaries, other, credit expense and amortisation, entered as yearly
--  amounts; crop costs are entered per decare.
--
--  `CostCategory` had eight values and no way to record either of the two
--  new overheads. Both are HOLDING-basis costs by nature — a tractor is not
--  consumed by one planting, and interest belongs to the year — so they
--  spread like PAYROLL rather than over a crop's area.
--
--  ADD VALUE IF NOT EXISTS is forward-compatible: a rolling deploy sees the
--  value before any code writes it, and re-running the migration is safe.
--  Enum values cannot be removed in Postgres, which is the reason this is a
--  deliberate two-line change rather than a convenience.
ALTER TYPE "CostCategory" ADD VALUE IF NOT EXISTS 'CREDIT';
ALTER TYPE "CostCategory" ADD VALUE IF NOT EXISTS 'DEPRECIATION';

--  `amountPerDca` — the per-decare figure AS TYPED.
--
--  `amount` stays authoritative and nothing downstream changes. This records
--  what the farmer actually entered, because `amount` alone cannot give it
--  back: dividing a rounded total by an area recovers a number they never
--  typed, and the calculator's "last values" default would drift further from
--  the truth on every reuse.
--
--  Decimal(14,4), not (14,2): a per-decare rate is divided before it is
--  multiplied back, so two places round away real precision. 1234.56 лв over
--  740 dca is 1.6683 лв/дка; storing 1.67 misstates the total by over 1 лв.
--
--  NULLABLE, and the null carries meaning — the farmer entered a TOTAL rather
--  than a rate. Backfilling it as `amount / area` would make every historical
--  entry look like a rate entry and erase that distinction, so it is left
--  null for every existing row.
ALTER TABLE "CostEntry" ADD COLUMN IF NOT EXISTS "amountPerDca" DECIMAL(14,4);
