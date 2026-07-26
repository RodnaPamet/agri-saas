# 2026-07-26 — Grain bin lifecycle: see it, blend it, empty it, delete it

**Commit:** `<pending> feat(grain): bin detail view, reachable blend, delete-with-stock refusal, kind-aware fill`

Stacked on `feat/grain-bin-unit-correctness` (the unit-correctness PR) — both
rewrite `grain-bin.ts`, so the dependency is a merge base rather than a
conflict.

## Problem

The entire lifecycle a farmer could perform on a bin was: create it, rename it,
change its capacity. Four specific gaps:

1. **No way to see inside.** No detail page existed. A row-click opened the EDIT
   form, so a READER — who cannot write — got a completely inert table, and
   `getBin`, a purpose-built read endpoint, had **zero callers**.
2. **Blend was unreachable.** `grain-blend.ts` was fully implemented,
   unit-tested, ledger-safe, mass-conserving, atomic and unit-strict — with no
   UI caller anywhere. Being unreachable is also why three real defects in it
   had never bitten.
3. **No way to empty or delete.** No delete route or usecase for bins at all.
4. **STORAGE measured the wrong thing.** Fill counted only
   `HARVESTED_PRODUCE`, yet a STORAGE row is exactly where seed and fertiliser
   live — so a full barn read as empty capacity.

## Design

### The fork: blend is WIRED, not removed

Removing a correct, tested, mass-conserving ledger writer to reduce surface
area would have been the wrong trade: it is also the product's only real "move
grain" action. It is now reachable from the bin detail — pick lots in this bin,
see the weighted-quality preview, confirm — and deliberately only from there,
because the destination is always the bin you are standing in.

**Reachability was gated on the three latent defects**, all fixed first:

- **TOCTOU double-spend.** The sufficiency check reads `quantityOnHand` *before*
  the ledger takes its per-tenant advisory lock, under READ COMMITTED, so two
  concurrent blends both passed and drove stock negative. Fixed by passing
  `disallowNegative: true` on the consumption appends — the ledger already had
  exactly this primitive, documented as running the balance re-read *inside* the
  lock, so the read and the insert are one race-free step. The pre-check stays
  because it produces a useful per-lot error before any write.
- **Unbounded input.** `sourceLots` had no `.max()`; each entry is a ledger
  append plus a genealogy edge inside one transaction holding the tenant's stock
  lock, so one request could stall every other stock write for that tenant to
  the 5 s timeout. Capped at 50.
- **No destination validation.** Added a `kind` check (blended grain could be
  receipted into a FIELD — on-hand stock invisible to every bin view) and a
  capacity check that runs *before* any ledger write, so a rejected blend leaves
  nothing behind.

### BIN vs STORAGE now means something

A `BIN` is a grain silo: fill measures produce. A `STORAGE` row is a barn/store:
fill measures **all** stock. That is the first real behavioural difference
between the two kinds — previously only the badge colour differed. Implemented
as two bounded aggregates split by kind, still not one per bin, so the query
count does not grow with the number of bins.

The org grain summary deliberately stays produce-only: `binStoredTonnes` is a
*grain* metric, and counting fertiliser in it would be a different lie.

### Delete refuses rather than warns

`InventoryLot.locationId` has no FK cascade and lots are not deleted with their
location, so deleting an occupied bin leaves every lot pointing at a
soft-deleted row: the stock stays on hand and keeps counting in inventory, but
vanishes from every bin view. Refusing is possible *because* the unit-correctness
PR added a way to move or unassign lots — the farmer is never stuck, and the
destructive path never has to guess what should happen to the grain. The count
covers stock of any category: seed in a barn orphans exactly like grain does.

## Files

| File | Role |
| --- | --- |
| `grain/bins/[binId]/page.tsx` | **New.** Detail page; 404s a FIELD/foreign/deleted id. |
| `grain/bins/[binId]/BinDetailClient.tsx` | **New.** Lots inside (code, item, quantity + UNIT, moisture/protein/test weight, expiry), fill summary, Edit / Blend / Delete. |
| `grain/bins/[binId]/BlendModal.tsx` | **New.** The blend entry point + client-side weighted-quality preview mirroring `blendQuality`. |
| `usecases/grain-bin.ts` | `getBin` returns the lots; fill is kind-aware; **new** `deleteBin` with the stock refusal. |
| `usecases/grain-blend.ts` | The three latent defects. |
| `schemas/grain.schemas.ts` | `sourceLots.max(50)`. |
| `api/.../grain/bins/[binId]/route.ts` | **New** DELETE. |
| `BinsClient.tsx` | Row-click → detail (was: edit). `editing` state removed rather than left permanently null. |

## Decisions

- **Quantities are shown per-lot in the LOT'S OWN unit**, not converted. The
  bin total is tonnes because it is compared to a tonnes capacity; a row saying
  "180 kg" is what the farmer wrote on the lot.

- **`lotsTruncated` rather than a silent cap.** The detail list is bounded at
  200 lots, but the totals above it come from the grouped aggregate and are
  exact regardless. A truncated list that looks complete is the bug class this
  roadmap started with.

- **Blend consumes WHOLE lots.** A partial-quantity blend is a different
  operation and the UI would have to explain the remainder; the API still
  accepts partial quantities for a future caller.

- **The delete button stays enabled and lets the server refuse.** Disabling it
  from the client's lot count would guess from possibly-stale data and give no
  reason; the server's message names the count.

- **Row-click goes to the detail page for everyone, including READERs.** That
  is the actual fix for the inert table — gating navigation on write permission
  was the original defect, not a safety measure.

- **`Checkbox` is Radix-based (`onCheckedChange`).** Noting it because the
  obvious `onChange` compiles against the DOM types and then silently never
  fires.
