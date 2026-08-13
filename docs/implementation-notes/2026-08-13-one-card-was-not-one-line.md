# 2026-08-13 — One card was not one line

**Commit:** `7041d2ec fix(trends): one card was not one line — collapse EC's per-market series (#550)`

Written after the fact: #550 shipped without a note and CLAUDE.md treats these
as a contract. Recorded here because the reasoning behind `chartSeriesFor`'s
dispatch is not recoverable from the code alone.

## What happened

#548 narrowed the Prices tab to one chart **card**. Production then drew twelve
**lines** inside it, and nothing in the test suite noticed, because
`toHaveLength(1)` on chart cards was a true statement about the wrong noun.

EC publishes cereals per market — Burgas, Plovdiv, Varna, Ruse, Dobrich, Pleven,
Stara Zagora — and `ecObservationsToItems` keys a series on `stage` while
dropping `market`. Prod's single `(BG, EUR, EUR/t)` group therefore held one
National Average, nine per-market rows under EC's old stage naming, and two
under its new naming.

Every rendered fixture carried one or two series per group. Twelve was a shape
nobody had sampled, so the suite was green about a case that never occurred in
it — the CLAUDE.md "green is not the same as executed" failure mode, arriving
through fixture poverty rather than through a skipped test or a dead branch.

## Why the collapse dispatches on SOURCE

The tempting rules are count ("more than two lines is too many") and freshness
("drop anything that stopped reporting"). Both are wrong, and wrong in a way
that only shows up on a different commodity:

- EC's per-market rows are **alternatives** — the same quantity measured in
  different places. The national average is the answer to "what is wheat worth
  in Bulgaria"; nine more lines add nothing.
- Diesel's `with-tax` and `without-tax` are **complements** — different
  quantities, both wanted, on one axis.

Nothing about a group's *shape* distinguishes those two cases. A count rule
would silently drop one of the diesel lines the moment a third stage appeared;
a freshness rule would drop whichever tax stage published later that week. Only
the source knows, so only the source decides: EC collapses, everything else
keeps every line.

## Why the national-average match is a substring

The stage text belongs to EC. They moved it once already — the market came out
of `stageName` (`"Burgas - DEPPROD"` → `"Departure from farm…"` plus a separate
`marketName`) shortly before 2026-08-10, which changed our series key and
orphaned nine Bulgarian wheat series mid-chart. A literal match would break on
the next rename; a case- and whitespace-insensitive substring survives one.

## Decisions

- **The tile is built from the DRAWN series, not the group**, so it cannot
  quote a line that is not on screen. Before this it read
  `leadSeriesOf(chartGroup)` over all twelve and displayed
  `Етап: Burgas - DEPPROD` — a per-market price, stale since 2026-07-20, above
  a chart of something else.

- **The rendered test counts the legend's REGION chip, not the source label.**
  `sources.official` also appears in the tile's provenance line, so counting it
  returns 2 and reads as a failure when the chart is correct. The first version
  of the test did exactly that.

- **This is display-side and stays display-side.** The companion ingest fix
  (`2026-08-13-ec-national-average-only.md`) stops STORING the per-market rows,
  but the display rule cannot be removed once it lands: it has to keep working
  against the twelve series already in the database, on every deployment, until
  those rows age out or are pruned.
