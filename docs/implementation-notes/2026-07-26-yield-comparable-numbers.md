# 2026-07-26 — Making two yield numbers comparable

**Commit:** _(this PR)_ — follows `2026-07-26-harvest-reconciliation.md`.

Two figures on the grain pages looked precise and were not comparable.

## 1. Moisture basis — FORK: compute a normalised tonnage

`moisturePct` was stored, displayed, and used in **zero** calculations —
confirmed by grep: no `netTonnes` / `dryTonnes` / `shrink` / `dryMatter` /
`standardMoisture` concept existed anywhere in `src` or `prisma`. So 90 t at
18% and 90 t at 13.5% were summed into one season total, ranked against each
other in t/ha tables, and printed side by side in the year-end PDF as the
same quantity of grain. The wetter load carries ~4.5% more water and
correspondingly less sellable dry matter; in a product where trade settles at
a standard basis, that is a measurement error.

Option (b) — label everything gross-at-mixed-moisture and stop comparing —
was available and rejected: the comparisons (season totals, t/ha rankings,
the per-field table, the group dashboard) are the product. Removing them
leaves a grain product that cannot answer "which field did better".

**The conversion** lives in `src/lib/grain/moisture.ts`, derived from the
invariant that water is the only thing being removed:

```
dry mass         = gross × (100 − m) / 100
mass at standard = dry mass / ((100 − s) / 100) = gross × (100 − m) / (100 − s)
```

with `s = STANDARD_MOISTURE_PCT = 14.0` (the EU / Bulgarian cereal delivery
basis).

**It is symmetric, deliberately.** Drier grain converts *up*. Commercial
settlement is usually asymmetric — a buyer shrinks wet grain but rarely pays
a bonus for dry — but that is a pricing policy belonging to the contract.
Baking it into an agronomic figure would make "how much grain is this?"
quietly answer a commercial question instead.

**Unknown moisture returns null, never "assume standard".** A record with no
reading has no comparable weight. The aggregates report those tonnes
separately (`unadjustedTonnes`) so an operator can see how much of a total
is un-normalised, rather than being handed a precise-looking number that
mixes bases again.

### Why the adjusted tonnage is a database-generated column

`YieldRecord.netTonnesStd` is `GENERATED ALWAYS AS ... STORED`.

Two forces pointed here. First, the portfolio rollups are **in-DB aggregates**
by contract, and normalising in application code would have meant loading
rows to do arithmetic the database can do in the aggregate — the exact shape
the recap is being moved *away* from in this same change. A real stored
column is `SUM()`-able. Second, a derived tonnage maintained by application
code drifts the moment one write path forgets to recompute it, and this one
already has three (the yield form, the journal-harvest mint from the previous
PR, and any future import). Postgres recomputes on every insert and update of
the inputs, so drift is unrepresentable rather than merely unlikely.

The cost is that Prisma does not model generated columns: it types the field
as writable, and a write earns `428C9` from Postgres — a 500 on code that
looks fine in the editor. `tests/guards/generated-columns.test.ts` is the
missing type check. It keys on write CALLS (`.create`/`.update`/… containing
a `data:` payload) rather than on the value's shape, because the column
legitimately appears as `netTonnesStd: true` in a `_sum` and as
`netTonnesStd: null` in a WHERE. It was mutation-proved: adding
`netTonnesStd: 999` to the yield create makes it fail with the offending
file and call named.

### Bounding the input

`moisturePct` was `NonNegativeNumber` — unbounded — against a `Decimal(5,2)`
column, so the API accepted **999.99%**, which the new formula would turn
into a *negative* adjusted tonnage. It is now bounded to
`MAX_PLAUSIBLE_MOISTURE_PCT = 40`, and `grossTonnes` / `areaHa` are bounded
to what their columns hold, so an out-of-range value is a 400 naming the
field rather than a Postgres `22003` surfacing as a 500.

## 2. One definition of t/ha

The yield page divided `grossTonnes` by `YieldRecord.areaHa`. The season
recap and the year-end PDF divided Σ `grossTonnes` by Σ `Parcel.areaHa` —
and the recap's select was `{ locationId, grossTonnes }`, so **the harvested
area the farmer typed was never read at all**. The same harvest printed
7.0 t/ha on screen and 4.2 t/ha in the PDF.

The canonical denominator is the **harvested area**: yield is what came off
the ground that was actually cut. One helper, `tonnesPerHectare`, is now
called by the DTO, the recap, the per-field table and (through the recap) the
PDF. The numerator is the adjusted tonnage where moisture is known, with
`tPerHaBasis` on the DTO saying which basis produced the number, so an
unadjusted figure never sits in a column looking identical to adjusted ones.

The whole-farm metric survives under its own name: `totalAreaHa` is still the
cropped area and still what `costPerHa` divides by — cost per farmed hectare
is a real and different question. The PDF now labels them apart ("Cropped
area" vs "Harvested area").

**The null-field inflation is fixed by construction.** A record with
`locationId = null` used to add tonnes to the numerator while contributing no
area to the denominator (area came from a per-location parcel map). Both now
come from the same aggregate over the same rows.

## 3. The recap stops truncating

`findMany({ take: 5000 })` with **no `orderBy`** meant that past the cap the
total silently dropped rows *and* which rows survived varied between calls —
while the portfolio view computed the same quantity as a real DB aggregate.
The two could disagree about one tenant's harvest, with the recap always the
one quietly wrong. It is now one `aggregate` + one `groupBy`, so nothing is
dropped and the two views agree by construction.

## Files

| File | Role |
|---|---|
| `src/lib/grain/moisture.ts` | the basis constant, the shrink formula, the one t/ha helper |
| `prisma/schema/grain.prisma` + `prisma/migrations/20260726150000_…/` | `netTonnesStd` generated column + its index |
| `tests/guards/generated-columns.test.ts` | nothing may write a Postgres-owned column |
| `src/app-layer/schemas/grain.schemas.ts` | moisture bounded to 40%, magnitudes bounded to column precision |
| `src/app-layer/usecases/yield-record.ts` | DTO carries `netTonnesStd` + `tPerHaBasis`; t/ha via the shared helper |
| `src/app-layer/usecases/season-recap.ts` | aggregates instead of a bounded scan; harvested-area denominator; adjusted/unadjusted split |
| `src/app-layer/reports/pdf/year-on-farm.ts` | labels the two areas apart, prints the 14% total, discloses unadjusted tonnes |
| `src/app/t/[tenantSlug]/(app)/grain/yield/YieldClient.tsx` | "At 14% (t)" column; a `*` and tooltip when t/ha is on the gross basis |

## Decisions

- **14.0% as a single constant, not a per-commodity table.** One basis is
  what makes a cross-commodity season total addable at all; a per-commodity
  basis needs a settlement model to mean anything. The constant is the seam
  if that arrives.

- **The average counts unadjusted tonnes rather than dropping them.**
  Excluding records with no moisture reading would understate the harvest;
  folding them in silently would re-mix the bases. They are counted, and
  `unadjustedTonnes` / `recordsWithMoisture` disclose exactly how much of the
  figure is un-normalised.

- **`costPerHa` still divides by cropped area.** It is not a yield metric and
  the farmed area is its correct denominator; the test pins that distinction
  so a future "consistency" cleanup does not collapse the two.

- **The old test asserting `avg t/ha = totalYield / totalArea` was the bug,
  written down.** It is rewritten around the corrected denominator with the
  7.0-vs-4.2 regression as its name, rather than adjusted until it passed.
