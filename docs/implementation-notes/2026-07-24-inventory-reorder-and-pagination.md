# 2026-07-24 — Inventory reorder level + cursor "load more"

**Commit:** `<pending>` inventory: finish reorder-level feature + wire cursor pagination

Two independent inventory-UI remediations landed together. Both are
pure UI-wiring over backend that was already built and verified.

## Design

### FLAG 2 — Low-stock reorder level (finish the dead feature)

`Item.reorderLevel` already drives the per-lot `lowStock` badge and the
daily low-stock-monitor job, but no form ever set it. Now two write
paths do:

- **New Product modal** gains a `reorderLevel` numeric field (state
  `pReorderLevel`), placed after the default-unit field. It ships as
  `reorderLevel: pReorderLevel.trim() ? Number(pReorderLevel) : null`
  in the existing `POST /items` body.
- **Edit product** — the product modal is now dual-mode (create vs
  edit, keyed by `editItemId`). An "Edit product" affordance in the lot
  detail modal (next to the item name) fetches the item via a new
  `GET /items/{itemId}`, pre-fills the modal, and saves via a new
  `PATCH /items/{itemId}`. The confirm label + title switch on mode;
  everything else (fields, validation, layout) is shared with create,
  so the duplication is one `if (editItemId)` branch in the submit
  handler + a couple of ternary labels.

Backend additions mirror the existing catalog seam:
`getItemDetail(ctx, itemId)` (full editable field read, Decimal
`reorderLevel` normalised to number) and `updateItem(ctx, itemId,
body)` (partial write — only provided keys touch the row; same
`sanitizePlainText` on free text as `createItem`; `entity_lifecycle` /
`operation: 'updated'` audit event).

### FLAG 5 — Cursor "load more" for the lot list + lot ledger

The lot list fetched the bare `/inventory/lots` (cap 200) and the lot
detail showed the inline `lotDetail.ledger` (cap 100) — neither had a
"more" path, so tenants above those caps couldn't reach everything. Both
now page their cursor endpoints:

- **Lot list.** First page is still SWR (`/inventory/lots?limit=50`) so
  create-lot / movement `mutate()` reseeds it; a `useEffect` reseeds the
  local accumulator from the SWR first page (the `useCursorPagination`
  `reload()` pattern). "Load more" sits in `ListPageShell.Footer`
  (anchored below the viewport-clamped table body).
- **Lot ledger.** Sourced entirely from the `/ledger` cursor endpoint
  (page 1 fetched on lot-open, since the inline `lotDetail.ledger`
  carries no cursor). `lotDetail` still supplies the header on-hand.
  Reseeds when `activeLotId` changes and after `postMovement`.

Both use one tiny local hook, `useInventoryCursor<T>` — accumulated
rows + nextCursor + hasMore + loading, with `seed()` (reseed page 1)
and `loadMore()` (fetch + append).

## Files

| File | Role |
| --- | --- |
| `src/app/t/[tenantSlug]/(app)/inventory/InventoryClient.tsx` | Reorder field, dual-mode product modal, edit affordance, `useInventoryCursor` hook, list + ledger load-more |
| `src/app/api/t/[tenantSlug]/items/[itemId]/route.ts` | **New** — `GET` (edit prefill) + `PATCH` (partial update) for a single item |
| `src/app-layer/usecases/catalog.ts` | **New** `getItemDetail` + `updateItem` usecases |
| `messages/en.json`, `messages/bg.json` | 8 new `inventory.*` keys (reorder, edit-product, saveProduct, loadMore) |
| `tests/rendered/ag-pages-a11y.test.tsx` | Fixture updated to the `?limit=50` envelope shape |

## Decisions

- **`{items,pageInfo}` vs `{rows,nextCursor}`.** The shared
  `useCursorPagination` hook consumes `{ rows, nextCursor }`, but the
  inventory endpoints return `{ items, pageInfo: { nextCursor,
  hasNextPage } }`, whose shape is locked by an OpenAPI DTO
  (`InventoryLotPageDTOSchema`) + load tests. Rather than reshape the
  endpoint (breaking those contracts), I adapted on the client with a
  ~30-line local accumulator that reads the envelope directly. It mirrors
  `useCursorPagination`'s seed/append semantics.
- **Flag 2 = finish it fully.** Delivered the New-form field AND the
  full item-edit reuse (GET+PATCH route, `updateItem` usecase, dual-mode
  modal) — not the compact fallback the brief allowed.
- **Ledger seeding = fetch from `/ledger`, ignore `lotDetail.ledger` for
  the list.** The simpler of the two brief options: the ledger list is
  driven purely by the cursor endpoint (page 1 on open), so "Load more"
  needs no cursor synthesised from the inline rows. `lotDetail` is kept
  only for the header on-hand.
- **`reorderLevel` input allows a decimal point**, not digits-only like
  `quarantinePeriodDays`. `Item.reorderLevel` is `Decimal(14,3)` and the
  API accepts `z.number().nonnegative()`, so a 2.5-unit threshold is
  valid; the input filter strips non-digit/dot and collapses extra dots.
- **Load-more lives in `ListPageShell.Footer`** (not inside `Body`) so it
  doesn't perturb the `fillBody` DataTable's viewport-height calc.
- **New route is non-privileged** — mirrors the existing `POST /items`
  (`withApiErrorHandling` + `withValidatedBody` + `assertModuleEnabled`
  + usecase-level `assertCanWrite`), so no `requirePermission` rule is
  needed (`items/` is not a privileged root).
