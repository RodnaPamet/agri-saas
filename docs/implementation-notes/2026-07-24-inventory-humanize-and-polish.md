# 2026-07-24 — Inventory: humanize enum pills + UI/polish fixes

**Commit:** _(uncommitted — working tree on branch `wip-reorder`; follows
`92f3eb7 feat(inventory): reorder-level field + item edit, cursor pagination
for lots & ledger`)_

## Design

Six flagged fixes to the inventory surface, all UI/polish or thin
defense-in-depth — no schema change, no behaviour change to the ledger
math or the API contract.

- **FLAG 6 — humanize raw enums.** The lot-ledger pill was rendering the
  raw `StockTransactionType` (`HARVEST_IN`, `SALE_OUT`, …) and the
  category chips were rendered via `String.replace('_', ' ')`, which
  only replaces the FIRST underscore (`HARVESTED_PRODUCE` →
  `HARVESTED PRODUCE` happened to look right, but the pattern is buggy
  and untranslated). Both now resolve through i18n label maps built with
  STATIC `t()` calls inside a `useMemo(…, [t])`, plus `humanizeStockType`
  / `humanizeCategory` helpers that fall back to the raw value for any
  unmapped member. Static keys (not `t(\`stockType.${x}\`)`) keep
  next-intl's compile-time key typing intact — no cast needed.
- **FLAG 7 — en.json was showing Bulgarian.** Six `inventory` keys
  (`activeIngredient`, `activeIngredientPlaceholder`, `quarantineDays`,
  `quarantineDaysHint`, `quarantineDaysPlaceholder`, `pppRegNo`) held
  Bulgarian text in the English locale. Replaced with real English; the
  `bg.json` values stay Bulgarian. Because `en ≠ bg` now for
  `activeIngredientPlaceholder`, its stale entry in the
  untranslated-copy allowlist is removed from both enforcement sites.
- **FLAG 8 — de-jargon the adjust label.** `signedDelta` read "Signed
  delta" / "Разлика (със знак)" — replaced with "Adjustment (+/−)" /
  "Корекция (+/−)" (real minus sign U+2212, matching the glyph in the
  label).
- **FLAG 9 — the clear polish wins** (c/d/e/f/g below); (a) and (b) are
  deliberately deferred with rationale.

## Files

| File | Change |
| --- | --- |
| `src/app/t/[tenantSlug]/(app)/inventory/InventoryClient.tsx` | FLAG 6 label maps + `humanize*` helpers (main component AND `TraceGroup` sub-component get their own map since each has its own `useTranslations`); `categoryOptions` uses `humanizeCategory`; ledger pill uses `humanizeStockType`; FLAG 9(e) receive-qty ≤ 0 guard on the Post button; FLAG 9(f) new Location column |
| `messages/en.json` | FLAG 7 EN fixes; FLAG 8 label; FLAG 9(f) `colLocation`; FLAG 6 `stockType` + `itemCategory` nested maps |
| `messages/bg.json` | FLAG 8 label; FLAG 9(f) `colLocation`; FLAG 9(g) non-circular `productModalHeaderDescription`; FLAG 6 `stockType` + `itemCategory` nested maps |
| `src/app-layer/usecases/inventory.ts` | FLAG 9(c) `reconcileStockLedger` `assertCanWrite` → `assertCanAdmin` (+ import) |
| `src/lib/inventory/stock-ledger.ts` | FLAG 9(d) on-hand cache `update` `where` scoped to the `id_tenantId` compound unique |
| `tests/guardrails/i18n-completeness.test.ts` | FLAG 7 — drop stale `inventory.activeIngredientPlaceholder` untranslated allowlist tuple |
| `scripts/i18n-diff.mjs` | FLAG 7 — drop the same stale allowlist string |

## Decisions

- **Static `t()` keys, no dynamic template literals.** Dynamic keys
  (`t(\`stockType.${type}\`)`) defeat next-intl's typed-key checking and
  would force a cast — banned by the `as any` ratchet. The label maps
  spell every member out; the helper does the runtime lookup with a
  raw-value fallback so an unmapped enum member degrades gracefully
  rather than throwing.
- **`TraceGroup` gets its own map.** It is a separate sub-component with
  its own `useTranslations('inventory')` scope; duplicating the small
  category map there is cleaner than lifting it through props.
- **FLAG 9(c) admin gate is defense-in-depth, not a behaviour change.**
  The only route calling `reconcileStockLedger`
  (`POST …/admin/ledger-reconciliation`) is already gated by
  `requirePermission('admin.manage', …)`; tightening the usecase policy
  from `assertCanWrite` to `assertCanAdmin` aligns the usecase-layer
  check with its sole caller. Admin operators have `canAdmin`, so no
  legitimate call regresses.
- **FLAG 9(d) tenant-scoped cache update.** The denormalised on-hand
  `inventoryLot.update` ran under RLS + a lot fetched in the same
  tenant-context transaction, so it was already safe; scoping the `where`
  to `id_tenantId` (`InventoryLot @@unique([id, tenantId])`) is a belt-
  and-suspenders match to the rest of the repository layer. Everything
  else in the append path is unchanged.
- **FLAG 9(e) is UX only.** The server already rejects a non-positive
  receipt (`receiveStock` throws `badRequest('Receipt quantity must be
  positive.')`); the client guard just disables the Post button so the
  operator never round-trips a doomed request.
- **FLAG 9(f) surfaces already-fetched data.** `location` is included on
  every lot row by the list query and mapped into the DTO but was never
  rendered. The new column reads `row.original.location?.name ?? '—'` and
  mirrors the `expires` column's mobile-card `meta` slot — zero new
  fetch.
- **FLAG 9(g) fixed a circular Bulgarian string.** The bg
  `productModalHeaderDescription` read "Продуктът е това, на което
  партидите са партиди." ("…lots are lots"). Replaced with a clean
  non-circular rendering of the EN ("A product is the thing lots are
  batches of."): "Продуктът е материалът, а партидите са неговите
  доставки."

### Deferred (documented, not implemented)

- **FLAG 9(a) — lot delete / product delete.** DEFERRED by design. Lots
  are **immutable-by-design**: a lot's `StockTransaction` ledger is
  append-only and FKs back to the lot, so deleting a lot would
  orphan/break the food-safety traceability chain. The `deletedAt`
  column stays reserved for a future soft-delete, but the UI treats lots
  as immutable — the correction path is "adjust to zero", not delete.
  Product delete is deferred for the same reason (products are
  referenced by lots + ledger). Product **edit** already shipped in the
  prior commit.
- **FLAG 9(b) — cost + valuation.** DEFERRED. The lot/ledger cost fields
  (`InventoryLot.unitCostAmount`, `StockTransaction.costAmount`) are
  currently **write-only** — the lot-create UI never sets them and no
  read path fetches them, so there is no "unused fetch" to drop.
  Surfacing a cost × on-hand valuation is a feature deferred to a later
  epic; bundled with it is the `InventoryLot.unitCostAmount`
  `DECIMAL(14,4)` vs `StockTransaction.costAmount` `DECIMAL(14,2)` scale
  reconciliation (a schema migration), which is moot until cost is
  actually surfaced.
