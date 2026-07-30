# 2026-07-30 — Rendered-suite viewport audit: which DataTable branch was green?

**Commit:** `<sha> test(rendered): make the jsdom viewport explicit where a card fallback hid the table branch`

## The defect class

`tests/rendered/setup.ts` polyfills `matchMedia` with a stub that answers
`matches: false` to **every** query. `useMediaQuery`
(`src/components/ui/hooks/use-media-query.ts`) derives the device from two
`min-width` probes:

```
matchMedia('(min-width: 1024px)').matches ? 'desktop'
: matchMedia('(min-width: 640px)').matches ? 'tablet'
: 'mobile'
```

Both probes answering `false` falls through to `'mobile'`. So the **entire
jsdom rendered suite runs as a PHONE**, silently, for every test that does
not override the stub — 2 of the 224 suites did.

That matters because `<DataTable mobileFallback="card">` branches on
`isMobile` in JS (not CSS) and renders exactly one of `<Table>` /
`<MobileCardList>`. And `MobileCardList` **omits every column without
`meta.mobileCard`**. So a test written against the desktop table exercises
a different component than its author believed, and a green run says
nothing about the branch named in the test's own docblock.

This is the same root cause as the tooltip touch regression: a global
`matchMedia` stub disabling a whole branch, with tests green about code
they never executed.

## What the audit measured

Two passes, because reading the tests was not enough to know which branch ran.

1. **Static**: resolve every rendered suite's transitive import graph
   (`@/` alias + relative, minus `jest.mock`'d modules) and intersect it
   with the 39 page-level `mobileFallback="card"` components in `src/`.
   11 suites reach one. Then scan those 11 for table-shaped assertions.

2. **Dynamic** (the part that changed the conclusion): a throwaway probe
   setup file wrapped `MobileCardList` and `Table` in counting shims and
   logged, per test, the **last** branch mounted. The first cut counted
   renders and reported `BOTH` for phone tests — because `useMediaQuery`
   starts at `device = null`, so DataTable renders the **table** on first
   paint and swaps to cards after the mount effect. Render counts are
   therefore ambiguous; only the last render is the branch the assertions
   see. That subtlety is why the static read alone would have been wrong.

## Findings

Of the 11 suites reaching a card-fallback component:

| Classification | Count | Suites |
| --- | --- | --- |
| Already overrides the viewport | 2 | `inventory-client` (desktop, wave 23), `traceability-panel-link` (desktop, for Combobox — table branch as a side effect) |
| Broken-but-green | 1 | `access-reviews-list` — "one row per campaign" asserted against a `<div hidden>` sidecar of empty `<span>`s |
| Passing for the wrong reason | 3 | `ag-pages-a11y`, `org-drilldown-load-more`, `grain-contracts-error-state` |
| Correctly card-branch (stale prose) | 1 | `mobile-card-list` — docblock described a CSS dual-render that no longer exists |
| Branch-agnostic (every column slotted) | 3 | `bin-detail-client`, `rent-client`, `traceability-panel-undo` |
| Does not render the DataTable | 1 | `locations-split-merge` (Map tab) |

Only **one** suite in the whole rendered tree asserted on a literal
`<tr>`/`<td>` under a card fallback — `inventory-client`, which wave 23 had
already fixed. The four other table-asserting suites
(`data-table-row-hover`, `data-table-row-selection`, `entity-metadata-copy`,
`epic-66-rollout`) pass no `mobileFallback`, so they render the table
unconditionally and were never at risk.

The real damage was **not** literal table selectors. It was three suites
whose *stated purpose* was the desktop table:

- **`ag-pages-a11y`** — the WCAG 2.1 AA axe sweep. Four of its six
  surfaces are card-fallback, so the `<table>` markup its own docblock
  names ("LocationsClient — locations list (DataTable + ListPageShell)")
  had **never been through axe**. Table a11y — column-header semantics,
  `scope`, row structure, `aria-sort` — is exactly what an axe sweep is
  for. This was the material hole.
- **`org-drilldown-load-more`** — docblock: "The render path goes through
  the real DataTable platform — these tests double as a smoke check that
  the wired-up tables render accumulated rows." The 150-row accumulation
  test never rendered a table.
- **`grain-contracts-error-state`** — locks "a failed read must not look
  like *no results*". `MobileCardList` and `Table` implement that choice in
  two separate places; only the card one was covered.

## Files

| File | Role |
| --- | --- |
| `tests/rendered/viewport.ts` | New. Shared `setViewport` / `restoreViewport` / `DEFAULT_VIEWPORT`, replacing wave 23's copy in `inventory-client`. Interprets `min-width` only, so it changes the device and nothing else. |
| `tests/rendered/viewport-helper.test.tsx` | New. **Executes** the mechanism: the default resolves to a phone, each `setViewport` band resolves to its device, `restoreViewport` restores, and `mobileFallback="card"` renders cards vs a real `<table>` accordingly. |
| `tests/rendered/ag-pages-a11y.test.tsx` | axe sweep parameterised over both viewports — the table branch is now audited. |
| `tests/rendered/org-drilldown-load-more.test.tsx` | Adds a desktop test asserting the accumulator appends real `<tr>`s under one `<tbody>`; docblock corrected. |
| `tests/rendered/access-reviews-list.test.tsx` | Replaces the sidecar-testid assertions with real card-branch and table-branch row assertions. |
| `tests/rendered/grain-contracts-error-state.test.tsx` | error-not-empty invariant asserted at both viewports; adds a desktop row test. |
| `tests/rendered/mobile-card-list.test.tsx` | Pins the phone explicitly; corrects the docblock's stale CSS-dual-render claim. |
| `tests/rendered/inventory-client.test.tsx` | Adopts the shared helper; its phone test pins `mobile` instead of inheriting it. |

## Decisions

- **The phone default was left in place.** This is a mobile-first product —
  the operator is standing in a field — so a phone is the honest default
  for a suite that mostly does not care. The defect was that it was
  *implicit*, not that it was wrong. Flipping it would move ~223 tests at
  once and make every currently-green card-branch assertion suspect in the
  same diff.
- **Tests that mean a phone now say so.** `setViewport('mobile')` on the
  card-branch tests costs one line and makes them independent of the global
  default — so a future default flip is a mechanical change to the suites
  that want a desktop, not a silent re-pointing of every card test.
- **No source-text guard was added.** The precise version needs the
  transitive import resolution the audit script does (alias resolution,
  `jest.mock` subtraction, barrel following) — fragile, and per the
  "green is not the same as executed" rule it would prove the shape of a
  test without executing anything. `viewport-helper.test.tsx` executes the
  mechanism instead: if a breakpoint is added to `useMediaQuery` or the
  setup stub changes, it fails there rather than silently reverting every
  `setViewport('desktop')` call site to a phone.
- **The `access-reviews-list` sidecar was left in the source.**
  `AccessReviewsClient` renders `<div hidden>` + one empty `<span
  data-testid="access-review-row-{id}">` per review, purely so tests need
  not reach into DataTable internals. It is a test-shaped artifact that
  cannot fail, and `tests/integration/access-review-api.test.ts` greps the
  client source for it — removing it is a two-file change that belongs in
  its own diff. The rendered test no longer relies on it.
- **Six other suites hand-roll their own `matchMedia` override**
  (`tooltip-touch`, `confirm-dialog`, `modal`, `deferred-on-mobile`,
  `responsive-toaster`, `traceability-panel-link`). Several need queries
  the shared helper deliberately does not interpret (`hover: none`,
  `pointer: coarse`, `prefers-reduced-motion`). Migrating them is a
  separate cleanup.
