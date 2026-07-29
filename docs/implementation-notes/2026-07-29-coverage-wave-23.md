# 2026-07-29 — Coverage wave 23: three client surfaces

**Commit:** _(this PR)_

Three React client components that write real data had never had their
*decisions* executed. Together they carried **114 uncovered functions**
on the `main@5b361224` CI artifact (run `30476856582` — the first run
after #458 made the barrel exclusion real).

| File | Before (fn) | After (fn) | Δ | After (br) |
|---|---|---|---|---|
| `planning/NewCropPlanModal.tsx` | 10/60 (16.66%) | 56/60 (93.33%) | **+46** | 79.25% |
| `inventory/InventoryClient.tsx` | 26/76 (34.21%) | 66/76 (86.84%) | **+40** | 80.78% |
| `components/ControlExceptionsPanel.tsx` | 15/50 (30.00%) | 43/50 (86.00%) | **+28** | 75.67% |

Measured effect on the `global` threshold group — the one the coverage
gate scores — by re-aggregating that artifact's per-file counters with
the three files' new ones. Not a projection: excluding or replacing one
file's counters cannot change another file's.

| metric | main today | this PR | floor |
|---|---|---|---|
| `global` **functions** | 65.38% (4176/6387) | **67.17%** (4290/6387) | 64 |
| `global` branches | 64.20% (13892/21638) | ≥ 64.20% | 63 |

**The gate is already green on `main`.** #458 (barrel exclusion) and
#459 (wave 22, nine repositories) both landed, and the Coverage job on
`5b361224` passed. This wave is therefore not a rescue — it is
**+1.79pp of headroom** so the floors can be ratcheted upward with room
to spare rather than pinned to the current number.

Branch coverage rises too (the three files gained 75-81% branch coverage
from ~0), but the aggregate is quoted as a floor: the artifact's
per-file branch totals were re-measured per file, not re-aggregated.

## Why these three files

`jest.thresholds.json` declares PATH thresholds for `./src/lib/` and
`./src/app-layer/{usecases,policies,events}/`. Jest **removes** any file
matching a path threshold from the `global` group, so the failing number
is scored over everything *else*. These three sit in that remainder and
are the three largest non-barrel entries in it that a jsdom test can
reach: 136 of the group's uncovered functions between them.

They also share a shape worth testing on its own merits. Each is a
*write* surface whose interesting work is invisible in a snapshot —
request-body coercion, endpoint selection, an accumulator, a permission
gate. A guard test over these files would prove nothing (see "Green is
not the same as executed" in CLAUDE.md); the only way to know a blank
numeric box becomes `null` rather than `0` is to submit the form.

## Files

| File | Role |
|---|---|
| `tests/rendered/new-crop-plan-modal.test.tsx` | new — 35 tests over the create-crop-plan flow |
| `tests/rendered/inventory-client.test.tsx` | new — 32 tests over the stock register |
| `tests/rendered/control-exceptions-panel.test.tsx` | extended — 15 existing render/gating tests kept verbatim, 15 mutation-path tests added |
| `tests/guards/rendered-coverage-floor.test.ts` | `RENDERED_TEST_FLOOR` 219 → 223, the live count |

## What is asserted

Behaviour that a wrong request body or a wrong branch would silently
change, not chrome:

- **`NewCropPlanModal`** — the re-seed-on-`open` effect; the variety list
  narrowing to the chosen crop type; the crop-type + default-method
  back-fill from a picked variety; `canSubmit`'s conjuncts; blank numeric
  boxes coerced to `null` (not `0`/`NaN`) and `notes` trimmed; the
  `generateNow && cropVarietyId` guard on the second POST and the hint
  that explains it; the inner `try` that swallows a `/generate` failure
  so a created plan is not lost; the three inline-create paths (season,
  crop type, variety) including their empty-search guard and their error
  surfaces; the parcel picker's largest-first sort, area labelling,
  disabled-until-a-location state, and failure fallback.
- **`InventoryClient`** — `useInventoryCursor` appending rather than
  replacing, and keeping `hasMore` alive after a failed page so a retry
  is possible; the `?lotId` deep-link entry the printed QR codes depend
  on; the dual-mode product modal (POST on create, PATCH on edit, prefill
  from `GET /items/{id}`, list revalidation after an edit); the lot move
  PATCHing position only; the receive/adjust split across two endpoints
  with two bodies and two gating rules; the ledger's sign prefix and the
  raw-enum fallback in `humanizeStockType`; the lazily-fetched genealogy.
- **`ControlExceptionsPanel`** — the four `useMutation` bodies (request /
  approve / reject / renew): their URLs, their JSON, the optional fields
  they must OMIT rather than send empty, the empty-server-body fallback
  message, and the `onSuccess` close + invalidate. Plus the
  self-reference filter on compensating controls and the standalone
  `ControlExceptionHeaderBadge` export.

## Decisions

- **`<Combobox aria-label>` is not forwarded to the trigger.** The
  trigger's accessible name is the selected option's label, falling back
  to the placeholder — so `getByRole('combobox', { name })` drifts with
  state and is unusable as a locator. All three suites resolve a picker
  through its `FormField` label instead (`[data-form-field="true"]` →
  `label` → `[role="combobox"]`), which is stable. Worth knowing before
  writing the next form test; worth fixing separately in the primitive.

- **jsdom reads as a PHONE, and the inventory suite now says so
  explicitly.** `tests/rendered/setup.ts` stubs `matchMedia` to
  `matches: false` for every query, and `useMediaQuery` derives its
  device from two `min-width` probes — both false means `isMobile`. So
  `<DataTable mobileFallback="card">` renders **cards**, and the desktop
  `<table>` branch is unreachable by default. Rather than paper over it,
  the suite keeps the phone default (that is the operator's real device)
  and adds a `setViewport('desktop')` helper for the one test that has to
  assert the table. Restored in `afterEach`.

- **`userEvent.setup({ delay: null, pointerEventsCheck: 0 })`
  throughout.** Radix sets `pointer-events: none` on `body` while a
  Dialog is open, which user-event refuses to click through; and the
  default inter-keystroke delay made the first draft of the crop-plan
  suite take 200 s. Text goes in via `fireEvent.change` for the same
  reason — these are controlled inputs with no per-keystroke logic worth
  simulating, except the numeric sanitisers, which get their own test.

- **One assertion was dropped as untestable here, not weakened.**
  `submitProduct` also revalidates the open lot's detail
  (`lotDetail ? mutateLot() : …`). Opening the product modal on top of
  the lot-detail modal makes Radix close the underlying dialog in jsdom,
  so `lotDetail` is already gone by the time the mutation resolves. The
  suite asserts the two refreshes that *are* observable (`/items` and the
  lots list) rather than asserting a spy that would pass for the wrong
  reason.

- **The existing `control-exceptions-panel` tests were kept verbatim.**
  They cover rendering and permission gating and stop at "is the button
  enabled?". The new block starts where they stop. Its `installFetch`
  gained an optional second argument for the POST response; the
  zero-argument call sites are unchanged.

## Mutation check

Nine mutations, applied one at a time, each confirmed caught by the
intended test, source restored and `git diff` verified empty after each.

| # | Mutation | Caught by |
|---|---|---|
| 1 | `varietyOptions` drops the `cropTypeId` filter | `narrows the variety list to the chosen crop type` |
| 2 | `plantsPerSuccession: Number(...)` without the blank→`null` check | `sends blank numeric boxes as null rather than 0 or NaN` |
| 3 | `if (generateNow && cropVarietyId)` → `if (generateNow)` | `skips generation — and says why — when no variety is chosen` |
| 4 | `loadMore` sets rows instead of appending | `appends page 2 instead of replacing page 1` |
| 5 | Post button drops the `Number(mvQty) > 0` clause | `refuses a non-positive receive` |
| 6 | `submitProduct` always `apiPost`s | `prefills from GET /items/{id} and PATCHes on edit` |
| 7 | compensating-control list drops the self filter | `offers every compensating control EXCEPT the one being excepted` |
| 8 | `RejectDialog` POSTs to `/approve` | `posts the reason to /reject and closes on success` |
| 9 | approve sends `toDateString()` instead of `toISOString()` | `refuses to approve without an expiry, then posts it as an ISO instant` |

Mutation 1 is additionally caught by
`creates a crop type inline and drops the stale variety with it`, which
asserts the narrowed list goes empty for a brand-new crop type. Every
other mutation failed exactly one test.
