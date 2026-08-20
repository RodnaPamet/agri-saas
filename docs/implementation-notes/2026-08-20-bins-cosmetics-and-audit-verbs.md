# 2026-08-20 — grain/bins cosmetics, and what the audit-verb item measured

**Issue:** #393 — "four cosmetic bins-page items trimmed from the roadmap"

## Design

Four independent one-liners, no shared design decision. Three landed as
written. The fourth landed as its *own* alternative, because the premise it
rested on is false by measurement — and that measurement is the durable part
of this PR.

### Items 1–3, as specified

1. **The Filter button opened an empty popover.** `useFilterContext([], [] as
   const, {})` and `defs: []` gave the toolbar a context for its live search
   box and nothing else. The issue offered "populate it or drop the button";
   **dropping it is not viable** — since the R14 reversal the free-text search
   lives *inside* that popover, so removing the button removes the search.
   Populated with the one real facet a bin has: `kind` (BIN vs STORAGE), which
   is not decorative — a BIN measures `HARVESTED_PRODUCE` only, a STORAGE row
   measures all stock.

   Single-select, deliberately: BIN and STORAGE are mutually exclusive, so
   selecting both would mean selecting neither. That also keeps the facet clear
   of the `multi-select-facet-route-parity` rule, which requires a CSV-parsing
   route counterpart for every `multiple: true` facet — and `GET /grain/bins`
   takes no query params at all.

   Filtering is in-memory alongside the existing text search, for the same
   reason: the route has no filter params and `listBins` already caps at
   `LIST_TAKE` (500), so there is a bounded loaded set to narrow.

2. **Double refetch on save.** `BinFormModal` already invalidates the
   `['grain-bins', tenantSlug]` key, which covers every observer; the list also
   passed `onSaved={() => binsQuery.refetch()}`. Two round-trips for one save.
   Dropped the explicit refetch — `onSaved` is optional and the detail page
   still uses it.

3. **No ETag on the list GET.** Now `jsonWithETag(req, bins)`, matching the
   cold-start convention and the sibling list reads.

### Item 4 — the premise was false, so the fix is the opposite one

The issue asks whether `LOTS_BLENDED` (`grain-blend.ts`) should be
canonicalised to `CREATE`, on the stated grounds that the audit vocabulary "is
dominated by `CREATE`/`UPDATE`/`SOFT_DELETE` (67 uses)" with bespoke verbs "a
scatter". Measured over every `logEvent` call site in `src/app-layer` carrying
a literal `action`:

| | sites | share |
|---|---|---|
| canonical (`UPDATE` 26, `CREATE` 22, `SOFT_DELETE` 9, `DELETE` 8) | 65 | 34% |
| bespoke domain verbs (106 distinct) | 128 | 66% |
| **total** | **193** | |

The issue's "67" is the canonical half counted alone. **Bespoke verbs are the
majority pattern**, and `docs/app-layer.md` teaches the domain form
(`action: 'WIDGET_CREATED'`) as its canonical example.

Within the family it belongs to, `entityType: 'InventoryLot'` has six audit
writes and five use domain verbs (`INVENTORY_LOT_CREATED`, `STOCK_RECEIVED`,
`STOCK_ADJUSTED`, `HARVEST_LOT_CREATED`, `LOTS_BLENDED`). Canonicalising the
blend would make it the only `InventoryLot` creation on `CREATE` while two
sibling creations keep theirs — worse local consistency, not better. It would
also erase the only field that separates the three: `detailsJson.operation` is
`'created'` for all of them, so the *verb* is what a SIEM filter has to work
with.

So the issue's second option is the right one — "accept domain verbs as a
deliberate pattern and write that down" — and the convention is now in
CLAUDE.md.

## Files

| File | Role |
|---|---|
| `src/app/t/[tenantSlug]/(app)/grain/bins/BinsClient.tsx` | item 1 (the `kind` facet, defined inline) + item 2 (dropped `onSaved`) |
| `src/app/api/t/[tenantSlug]/grain/bins/route.ts` | item 3 (`jsonWithETag`) |
| `src/app-layer/usecases/grain-blend.ts` | item 4 — comment recording why `LOTS_BLENDED` stays |
| `src/app-layer/usecases/inventory.ts` | item 4 — corrects the #391 comment that asserted the false version |
| `CLAUDE.md` | the audit-verb convention, with the measured distribution |

## Decisions

- **The `kind` filter defs are inline, not a sibling `filter-defs.ts`.** The
  labels have to come from `t()` regardless (the sibling grain defs hard-code
  English), and `tests/guards/no-hardcoded-ui-strings.test.ts` caps hard-coded
  config props at a baseline the tree currently sits *exactly* on — a new file
  with `label: 'Kind'` would breach a one-way ratchet. A `t(...)` initializer
  is a `CallExpression`, not a `StringLiteral`, so it is correctly invisible to
  that scan.

- **`FilterIcon` is derived from the contract, not imported.** It is a
  *file-local* union inside `@/components/ui/filter/types` and is not exported;
  importing it by name does not compile. `grain/costs/filter-defs.ts` is the
  precedent: `type FilterIcon = FilterDefInput['icon']`.

- **#391's comment was corrected, not deleted.** Its *choice* (`UPDATE` +
  `changedFields: ['locationId']` for a lot move) is right — changing
  `locationId` genuinely is a field update. Only its stated *reason* was wrong.
  CLAUDE.md's rule is that a PR invalidating a claim updates the claim in the
  same diff, and that comment is exactly the kind of thing the next engineer
  would cite as precedent for a canonicalisation sweep.

- **Both new comments sit ABOVE their `logEvent` call, not inside the object
  literal.** Not stylistic: `tests/guards/audit-structured-events.test.ts`
  scans a **fixed 15-line window** from the `logEvent(` line for `detailsJson`,
  so a long comment inside the body pushes it out of range and the guard
  reports a violation on a fully compliant call site. Placing the comment above
  the call is both the better home for a "why this verb" note and clear of the
  window. The window is a latent trap for the next well-documented call site —
  it also admits a false *negative* (when no `});` falls inside the window, the
  snippet spills into the following call and can borrow its `detailsJson`) —
  but fixing the scanner is out of scope for a cosmetic chore and is left
  named here rather than silently worked around.
