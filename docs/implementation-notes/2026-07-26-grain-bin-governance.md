# 2026-07-26 — Grain bins: plan gate, Location sharing, archived state, fill honesty

**Commit:** `<pending> fix(grain): plan-gate bins, filter and guard Locations, honor archived, tell one fill number`

Third and final PR of the grain-bin roadmap. Scope was **trimmed after re-evaluating
the brief against the code**: two of the original twelve items were already resolved
by the earlier PRs, and four were cosmetic enough to move to a standalone chore
issue (#393). What remained are five items with real consequences.

## The shared-`Location` problem

A "bin" is a `Location` row whose `kind` is BIN or STORAGE. That sharing was
unmanaged in four independent ways, all of which this PR closes.

### Plan gate (flag 6)

`createLocation` gates on `assertWithinLimit(ctx, 'location')`; `createBin` went
straight to `db.location.create`. But the entitlement counter has **always**
counted every Location row regardless of kind — its comment said "farms / fields"
while the query had no `kind` filter. So the count and the gate disagreed in both
directions: a FREE tenant could mint unlimited Locations through the grain
endpoint, **and** every bin silently consumed the field budget that
`createLocation` is checked against. A farmer's 6th field was rejected because of
bins nobody told them counted.

**Decision: share the `location` cap rather than add a `grain_bin` resource.**
The counter already means "any Location", so this makes the gate match the count
instead of introducing a second dimension. Splitting them would additionally
require *excluding* bins from the existing `location` count — a behaviour change
to a shipped gate — and inventing per-plan bin numbers with no product input. If
distinct budgets are wanted later that is a pricing question, and the mechanics
are a `PLAN_LIMITS` entry + a `getCurrentCount` arm + kind-filtered counts on
both resources.

### Bins leaking into `/locations` (flag 7a)

`LocationRepository._buildWhere` applied no `kind` filter, so bins rendered in the
fields table with columns that don't describe them — "0 parcels" and a Status
that doesn't apply. The list now requests `?kind=FIELD`. The filter *capability*
shipped in the first PR of this roadmap (it was needed for the storage picker), so
this is one query-string change.

### Unguarded location delete (flag 7b)

`DELETE /locations/{id}` and `/locations/bulk/delete` had no dependent-stock
check. `InventoryLot.locationId` has no FK cascade and lots aren't deleted with
their location, so soft-deleting an occupied row leaves every lot pointing at a
deleted Location: the stock stays on hand and keeps counting in inventory, but
disappears from every bin view.

This became the sharpest item *because of* the previous PR: it added a bin delete
that **does** refuse, so the codebase had two delete paths to the same table
disagreeing about whether stock matters. A guard on only one path is arguably
worse than none — the protected path teaches you to trust a protection the other
lacks.

**Decision: guard the stock, not the `kind`.** Blocking bin deletion from
`/locations` would leave bins undeletable for any tenant without the GRAIN module,
since the grain route is module-gated and this is then the only path. The
integrity risk is orphaned stock, not which page you deleted from.

**Decision: bulk refuses the WHOLE batch.** It runs in one transaction, so a
partial delete followed by a throw rolls back anyway — and "deleted 3 of 5,
silently" is worse than a clear refusal that names the offenders.

### Archived bins (flag 8)

Bin reads filtered `tenantId`/`deletedAt`/`kind` but never `Location.status`, so
an ARCHIVED bin kept counting toward stored/fill and appeared as if live.

**Decision: surface it on the bin pages, exclude it from the org metrics.**
Filtering archived bins out of `listBins` would be a trap: the grain UI cannot
change a Location's status (that is `/locations`' half of the deliberately split
writer), so a hidden archived bin would have no route back from the page that
manages bins. But archived capacity is *not* operating capacity, so
`portfolio-grain` now filters `status: 'ACTIVE'` — counting it deflated
`binUtilisationPct` and inflated `binCount`/`binCapacityTonnes` org-wide.

Only the exceptional state is badged; ACTIVE is the norm and a badge on every row
is noise.

### BIN vs STORAGE (flag 10)

The behavioural half landed in the previous PR (a BIN measures produce, a STORAGE
row measures all stock), so the two kinds are no longer identical. What remained
was that the form still gave the farmer no way to know *which* to pick. One line
of hint copy, en + bg.

## Fill honesty (flag 12.1)

`ProgressBar` clamped its bar to 100% while callers passed the **true**
percentage in `aria-label`, so a 140%-full bin showed "100%" to a sighted user
and announced "140%" to a screen-reader user. Over-full is the one signal a
farmer most needs.

Fixed **centrally** rather than per call site — the previous PR's bin detail page
had already reused the same pattern, so the mismatch existed in two places and
would have kept spreading. `progress-bar.tsx` already carried a computed
`data-overflow` attribute that was never rendered, which reads like a hook left
for exactly this.

The resolution needed one ARIA detail: `aria-valuenow={140}` with
`aria-valuemax={100}` would be out of range and invalid. `aria-valuetext` exists
precisely for this — it is the human-readable value assistive tech announces, and
it can say "140%" while `valuenow` stays clamped and spec-valid. So all three
channels (visible label, announced text, machine value) now describe the same
reality *and* remain compliant. Overflow also gets a visible ring, because a full
track is otherwise indistinguishable from exactly-100%.

`ProgressBar` had **zero tests** despite being used across the product; it now has
seven, including `max: 0` (the divide-by-zero guard) and a negative value.

## Files

| File | Role |
| --- | --- |
| `usecases/grain-bin.ts` | Plan gate on `createBin`; `status` surfaced through both reads. |
| `lib/billing/entitlements.ts` | Corrected the `location` counter's comment — it counts bins too, and always did. |
| `usecases/location.ts` | `assertNoDependentStock` shared by both delete paths. |
| `usecases/portfolio-grain.ts` | Archived bins excluded from org capacity metrics. |
| `components/ui/progress-bar.ts(x)` | True percentage + `aria-valuetext` + visible overflow. |
| `LocationsClient.tsx` | `?kind=FIELD`. |
| `BinsClient.tsx`, `BinDetailClient.tsx`, `BinFormModal.tsx` | Archived badge, status in the meta strip, kind hint. |
| `lib/dto/grain.dto.ts`, `public/openapi.json` | Contract + regenerated spec. |

## Decisions worth revisiting

- **Sharing the `location` cap is a pricing statement**, not just an
  implementation choice: on FREE, five fields *and* bins combined. If that reads
  as too tight, the split is mechanical — see flag 6 above.
- **`aria-valuenow` stays clamped.** If a future audit wants the true value
  there, it needs `aria-valuemax` raised too, which changes what "100%" means to
  AT. `valuetext` was the smaller, spec-sanctioned lever.
- **The spec was regenerated proactively.** The first PR of this roadmap learned
  this the hard way: `tests/contracts` is only 2 suites and is easy to miss when
  sweeping locally, but it owns the published API contract, so any DTO change
  drifts `public/openapi.json`.
