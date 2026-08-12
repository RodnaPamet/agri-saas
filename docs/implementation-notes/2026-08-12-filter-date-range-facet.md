# 2026-08-12 — The `dateRange` filter facet

**Commit:** (pending — see PR)

## Design

`/grain/costs` shipped without a date filter and said so in its own
docblock: `Filter.type` was `"default" | "range"`, and `range` is a pair of
min/max NUMBER inputs whose codec runs `Math.trunc` on each bound.
`Math.trunc('2026-08-12')` is `NaN`, so the existing facet could not carry a
date at all. The absence was pinned by an assertion in
`costs-page-contract.test.ts` (`has NO date facet, and says why`) — a
forcing function, so that closing the gap meant deleting the claim in the
same diff rather than leaving two contradicting statements in the tree.

This adds the third facet kind.

```
Filter.type = "default" | "range" | "dateRange"
                            │           │
                 FilterRangePanel   FilterDateRangePanel
                 (number inputs)    (a <Calendar mode="range">)
                            └─────┬─────┘
                          the SAME token shape: "lo|hi"
                    so URL sync, active-filter state and the
                    pill need no new case — they ask
                    isRangeType(), never the literals
```

### What is shared and what is not

Shared: the token shape, the `"|"` empty sentinel, the panel header, the
clear/apply handlers, and every piece of state plumbing.

Not shared: the alphabet of a bound. `range` bounds are numbers, `dateRange`
bounds are `YYYY-MM-DD`. Reading a date token with the numeric parser gives
`NaN` on both sides, which is not a small mis-render — it reports a fully
applied window as *no filter at all*. That fell out in three places, and
each is now decided per kind, once:

- `hasAppliedRange` (drives the panel's Clear button) → shape-based.
- `rangeTokenIsComplete` (drives Escape closing the whole popover) → new,
  shape-based; it replaced an inline numeric parse.
- `rangeTokenBounds` (drives the pill label) → new, validates per kind.

### The codec is not new

Epic 58's `date-picker/date-utils` already exported `toRangeToken` /
`parseRangeToken` producing exactly `"YYYY-MM-DD|YYYY-MM-DD"`, UTC-anchored.
The facet uses those, aliased at the filter barrel as `encodeDateRangeToken`
/ `parseDateRangeToken` so a page author imports from the filter system like
everything else and never has to know which module owns the format.

### Server side

`parseDateRangeParam` in `@/lib/validation/query-params`, sitting beside
`parseCsvEnumParam` and for the same reason: the facet serialises to ONE
param, and handing that whole string to a Prisma comparison throws — a 500
the list page renders as its EMPTY state, i.e. a confident "no costs in that
window" in response to a crash.

It widens the upper bound to end-of-day. `incurredOn` is a `DateTime`, so a
literal `lte: 2026-08-12T00:00:00Z` matches only rows stamped exactly
midnight — in practice none — and a farmer filtering a single day would see
an empty table and conclude the data was gone.

No migration: `CostEntry` already carries `@@index([tenantId, incurredOn])`
and `@@index([tenantId, category, incurredOn])`.

## Files

| File | Role |
| --- | --- |
| `src/components/ui/filter/types.ts` | `FilterKind` union + `isRangeType()` — the derived membership test the four branch sites now ask |
| `src/components/ui/filter/filter-date-range-panel.tsx` | New. The calendar body, the click-count range logic, the UTC re-anchor |
| `src/components/ui/filter/filter-range-panel.tsx` | `FilterRangeHeader` → exported `FilterPanelHeader`, shared by both panels |
| `src/components/ui/filter/filter-range-utils.ts` | `rangeTokenBounds` — per-kind bound validation for the pill |
| `src/components/ui/filter/filter-select-utils.ts` | `hasAppliedRange` made shape-based; `rangeTokenIsComplete` added |
| `src/components/ui/filter/filter-select.tsx` | The `dateRange` branch; clear/apply handlers hoisted so the two branches share one definition |
| `src/components/ui/filter/filter-list.tsx` | Pill label + the pill's own edit popover, both kind-aware |
| `src/components/ui/filter/index.ts` | Barrel: `FilterKind`, `isRangeType`, and the two codec aliases |
| `src/lib/validation/query-params.ts` | `parseDateRangeParam` |
| `src/app-layer/repositories/CostEntryRepository.ts` | `incurredFrom` / `incurredTo` on `CostEntryFilters`; the guarded `incurredOn` where-clause |
| `src/app/api/t/[tenantSlug]/grain/costs/route.ts` | Parses `?incurredOn=` |
| `src/app/t/[tenantSlug]/(app)/grain/costs/filter-defs.ts` | The facet; the "why there is no date facet" docblock deleted |

## Decisions

- **A separate panel, not a mode on the numeric one.** They share a token
  shape and nothing else: different alphabet, different input surface,
  different validity rule. Folding them together would mean a component
  whose every branch asks which kind it is.

- **`isRangeType()` instead of `type === 'range' || type === 'dateRange'`.**
  The range branch is tested in four files. Every one of them would have had
  to be found and edited by hand to add a third token-shaped kind — and the
  one nobody finds is the bug. The membership lives in `types.ts`.

- **The panel mounts `<Calendar>`, not `<DateRangePicker>`.** The picker is
  a trigger plus its own `<Popover>`, and this panel is already inside the
  filter popover. Nesting dismissable layers gives two of them racing for
  the same Escape key and the same outside-click.

- **Every click commits.** The first click applies `X|X` — a single-day
  filter, which is a real question ("what did I spend on the 12th") and
  removes any doubt that the click registered. The second closes the window.
  A click after a COMPLETE window starts over rather than widening one the
  user considers finished.

- **The range is driven from our own click count, not react-day-picker's
  inference.** `<DateRangePicker>` learned this first and says so in its
  `handleCalendarSelect`: rdp's inference differs between v8 and v9 and does
  not reproduce under jsdom, so a test would be asserting the library rather
  than us.

- **An open-sided token renders even though the calendar cannot make one.**
  A shared or hand-edited URL can carry `"2026-03-01|"`, and rendering it as
  "1 Mar 2026 – No max" costs one branch. Deciding what a half-parsed filter
  means at read time costs more.

- **The rendered test says which timezone it is asserting, and admits when
  it cannot.** Two of the bugs it caught — a click stored as the day BEFORE
  the one clicked, and the calendar opening on the PREVIOUS month — are
  invisible at UTC offset 0. Pinning the zone from inside the file was tried
  and does not work (Node caches it before the first test; the self-check
  asserting otherwise failed, which is why the file now says so instead of
  claiming coverage it has not got). Both cases were run against
  `America/Los_Angeles`, `Europe/Sofia`, `UTC` and `Pacific/Kiritimati`, and
  both failed before the fixes landed.

- **A malformed bound reads as ABSENT.** A hand-edited URL should degrade to
  "No min" rather than render the string `NaN` into a pill. The server
  rejects the same token with a 400, so nothing acts on it either way.
