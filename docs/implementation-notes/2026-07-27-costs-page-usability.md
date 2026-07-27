# 2026-07-27 — The costs page: sortable, attributable, honest

**Commit:** _(this PR)_ — third of the cost roadmap.

A 500-row financial table with no sort, no search, no filter and no
pagination — and two guard exemptions that said otherwise.

## 1. Sorting that did not exist, and two guards that claimed it did

`sortableColumns` was never passed to `DataTable`, so it defaulted to `[]`
and nothing sorted. Meanwhile **two** guard exemptions justified the page's
missing toolbar with the phrase "+ sort":

- `filter-toolbar-coverage.test.ts`
- `columns-dropdown-coverage.test.ts`

A false exemption is worse than a missing feature: it tells the next reader
the gap was considered and accepted, so nobody looks again. Both rationales
now describe what exists, and both say plainly that the "+ sort" claim was
untrue until this change — a rationale that has been wrong once should carry
that history, or it will be reworded into fiction again.

Sorting defaults to **total cost, descending**: a farmer's first question is
"what cost me most", and answering it should not require reading 500 rows.
Rows with a null value sort **last in either direction** — a row with no
cost-per-tonne is missing a denominator, not cheap, and floating it to the
top of "cheapest first" would read as a finding.

A name search was added alongside the dimension toggle. Deliberately not a
faceted `FilterToolbar`: this report has dimensions, not facets — but 500
rows with no way to reach one of them is not a report anybody can use.

## 2. Multi-planting attribution — FORK: split evenly

`LogPlanting` is many-per-entry (`@@unique([logEntryId, plantingId,
stage])`), and the rollup collapsed it into a last-write-wins
`Map<logEntryId, plantingId>`. A spray covering three plantings therefore
dumped its **entire** cost onto whichever one the database returned last —
over a read with no `orderBy`, so the row carrying the cost moved between
refreshes. The code comment ("a log entry realises one planting stage")
asserted the opposite of what the schema allows.

**Decision: split the cost evenly across the plantings the entry covers.**

A pro-rata split by area was considered and rejected: planting area is
frequently null, so it would silently fall back to an even split for exactly
the farms whose fields differ most in size — worse than being predictably
even everywhere. If area-weighting is wanted later it needs area to be
required, which is a data-entry decision.

Two subtleties, both tested:

- The same planting linked at two **stages** is one planting, not two
  shares.
- The split **conserves the total**: summing every row still returns what
  was spent. A distribution rule that leaks or invents money is worse than
  the concentration bug it replaces.

## 3. "Total cost" was not total

The rollup covers `LogEntry.costAmount` plus the stock consumed against
those entries. It does **not** cover machinery (the `LogEquipment` link
exists but `Equipment` has no cost field), labour, land rent, fuel, or
purchase contracts.

The column is now **"Recorded cost"**, and the page states what is excluded
rather than implying completeness by omission. Broadening it was not
attempted here: each missing category needs its own capture surface first,
and a total that grows by guesswork is the failure this roadmap exists to
remove.

The stale comment advertising "seed / fertiliser / chemical / labour / fuel"
columns is gone. Those columns never existed — the comment was the residue
of a category breakdown that was designed and dropped, and describing them
was the only part that shipped. Building it needs cost **categories** on the
underlying entries, which the schema does not have.

## 4. Language and plumbing

- **"Field-event cost" → "Journal cost"** (bg: "Разход от дневника"), and
  the journal's own hint drops the Ekylibre word "intervention". A farmer
  should be able to connect what they typed to what they read.
- **Bulgarian inconsistency fixed.** The toggle said "По насаждение"
  (an orchard/plantation) while the column header said "Посев" (a sown
  crop) — two different words for one thing, on one screen. For grain,
  посев is correct.
- **The hardcoded English `'Planting'` fallback is gone.** It rendered
  "Planting #3" untranslated for a Bulgarian farmer. A planting whose crop
  plan has no name is now identified by its succession number alone.
- **`?seasonId` applies to every dimension.** It was accepted and silently
  ignored on `by=field` / `by=season`, so a shared filtered link showed the
  whole farm.
- **The 500-cap on name resolution is gone.** It silently dropped NAMES, so
  a real field past row 500 rendered as "unassigned" — which reads as a
  data-entry problem rather than a display limit.
- **`jsonWithETag`** on the list GET.
- **DTOs.** `GrainCostRowDTOSchema` had zero code consumers but IS in the
  published OpenAPI spec — so it was the endpoint's contract, and stale
  (it described a `currency` field that no longer exists). Updated, and
  `GrainSeasonCostRow` / `GrainFieldCostRow` added: the endpoint returns
  three shapes and documenting one of them wrongly was the worst option.
- **`data-testid` kept, deliberately.** The brief asks for an HTML id per
  house convention — but `DataTable` renders `<div id={dataTestId}
  data-testid={dataTestId}>`, so the prop **already emits an HTML id**. The
  convention is satisfied in the DOM; changing the call site would break the
  component's prop contract for no DOM difference.
- **The page has tests now** — 14 structural assertions. Deliberately
  structural: what broke here was wiring (a prop not passed, a param
  accepted and ignored, a literal that never reached a translator), and a
  source scan catches wiring cheaply.

## Decisions

- **Even split over pro-rata.** Predictable everywhere beats accurate for
  some farms and silently even for the rest.
- **Conservation is a test, not an assumption.** The distribution is only
  correct if the parts still sum to the whole.
- **The guard rationales record that they were wrong.** A corrected comment
  that hides its own history invites the same fiction next time.
