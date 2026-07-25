# 2026-07-25 — Grain contract defect fixes (multi-select 500, error surface, contracted-tonnes semantics, status lifecycle)

**Commit:** `<pending>` fix(grain): repair multi-select filtering, surface read failures, and define "contracted"

Five defects around the grain-contracts surface. Four were independent;
two (the 500 and the missing error surface) were two halves of the same
user-visible symptom, which is why they land together.

## Design

### 1. Multi-select facet → 500 rendered as "no results"

The chain was broken end to end:

```
filter-defs.ts        status/type declared `multiple: true`
      ↓
filter-state.ts       filterStateToUrlParams comma-joins  →  ?status=DRAFT,ACTIVE
      ↓
contracts/route.ts    sp.get('status')                    →  "DRAFT,ACTIVE"  (scalar!)
      ↓
contract.ts           filters.status as EnumContractStatusFilter['equals']
      ↓
Prisma                PrismaClientValidationError         →  500
      ↓
ContractsClient       data ?? []                          →  "No contracts match your filters"
```

The cast at the usecase boundary is what made the 500 possible: a raw
`string` was asserted into an enum type, so the compiler stopped asking
questions and Prisma found out at runtime.

Fixed by making the type carry the invariant instead of hiding it:

- `ContractListFilters` now takes `status?: ContractStatus[]` /
  `type?: ContractType[]` — real enum arrays, no cast. An unvalidated
  string can no longer reach Prisma without a compile error. (The change
  immediately caught the one stale call site: the old scalar test.)
- The query uses `{ status: { in: [...] } }`, guarded on `.length` so a
  CLEARED facet omits the filter rather than emitting `{ in: [] }` — which
  matches zero rows and would have reproduced the empty-table symptom by a
  different route.
- New `parseCsvEnumParam` (`src/lib/validation/query-params.ts`) splits,
  trims, de-duplicates, and validates every member with
  `z.nativeEnum(...)`. An invalid member is `badRequest` → a clean 400.

**Why 400 and not "drop the bad member":** the existing precedent
(`traceability/graph/route.ts::parseKinds`) silently drops unknown values.
For a filter that is the wrong default — dropping a member silently widens
the result set past what the operator selected, and a filter that lies is
worse than one that errors. The helper is deliberately stricter than the
precedent it resembles.

### 2. No error surface — failures rendered as an empty table

`ContractsClient` did `contractsQuery.data ?? []` and never passed `error`
to `EntityListPage`, which supports it. So every failure mode — 500, 403,
offline, DNS — rendered the table's EMPTY state. "No contracts match your
filters" is not a neutral fallback: it is a confident claim about the data,
and it is the opposite of what happened.

All four grain clients had the defect; all four now compute a `loadError`
and pass it through (`CostsClient` has three dimension-branch tables, so
three call sites).

**The one subtlety** — `<DataTable>` renders `error` *instead of* the
table, so raising it unconditionally would blank rows the operator can
already see when a background refetch fails. Each site therefore gates on
having nothing to show (`isError && rows.length === 0`, or `isError &&
!data` for the costs rollup). Failure with stale rows keeps the rows;
failure with nothing keeps the error. A rendered test pins both directions.

### 3. "Contracted tonnes" counted drafts and cancellations

`portfolio-grain.ts` grouped contracts by type with no status filter, so an
unsigned DRAFT, a void CANCELLED, and a paid-and-closed SETTLED contract
all inflated the group operator's headline commitment. The number could
only ever grow — opening the create modal raised it, cancelling a deal did
not lower it, and within a year prior-season settlements dominated it.

Decided, and recorded as `CONTRACTED_COMMITMENT_STATUSES = ['ACTIVE',
'DELIVERED']` in the new domain module:

| Status | Counted | Why |
|---|---|---|
| `ACTIVE` | ✅ | signed and live — the commitment |
| `DELIVERED` | ✅ | volume moved, not yet settled — still on the books |
| `DRAFT` | ❌ | unsigned; a scratch row is not a commitment |
| `CANCELLED` | ❌ | void |
| `SETTLED` | ❌ | delivered AND paid — history, and it never leaves the table |

So "contracted" means **the live book**, not a lifetime total. A
lifetime or per-season view is a legitimate but *different* question and
wants its own field rather than a redefinition of this one.

**Operator-visible consequence:** on deploy this headline steps DOWN for
any tenant carrying drafts, cancellations, or settled history. That is the
correction, not a regression — but it will be noticed, so it is called out
here. The KPI label was left alone (`KpiCard` has no tooltip slot, and
adding one touches a shared primitive with many call sites).

### 4. Unvalidated status transitions

`updateContract` did a bare `data.status = input.status`, so the API
accepted SETTLED → DRAFT, DRAFT → SETTLED (skipping both signature and
delivery), and re-opening a CANCELLED contract. The lifecycle was
documented on the Prisma enum and enforced nowhere.

New `src/app-layer/domain/contract-status.ts` mirrors the existing
`work-item-status.ts` state machine (same `check*` / `format*` pair, same
Prisma-free literals so it is requireable from a node env):

```
DRAFT ──→ ACTIVE ──→ DELIVERED ──→ SETTLED        (terminal)
  │         │            │
  └─────────┴────────────┴────────→ CANCELLED     (terminal)
```

Two deliberate divergences from the work-item precedent:

- **`from === to` is LEGAL here.** Work items move through a dedicated
  `setTaskStatus` endpoint where a no-op is meaningless. A contract's
  status rides the general PATCH body, and `ContractFormModal` submits the
  *whole form* — so every "fix a typo in the counterparty" edit re-sends
  the unchanged status. Rejecting the no-op would make a SETTLED or
  CANCELLED contract permanently uneditable. The no-op passes and simply
  writes nothing.
- **`createContract` is unconstrained.** A contract that is already
  mid-lifecycle must be recordable at whatever stage it is in; only
  subsequent moves are checked.

The guard needs the current status, so the `status` assignment moved out
of the pre-transaction `data` block and into the transaction, after the
existing row is read (`select` widened to include `status`).

**Seam for flag-3 fulfillment** (not yet landed): once deliveries are
tracked against a contract, ACTIVE → DELIVERED should additionally require
evidence that volume actually moved. That check belongs beside the graph
check, reads `db` + `id` (both already in scope), and needs no signature
change. Left as a marked comment rather than a stub — an unreachable
helper would be dead code today.

### 5. Data-quality quick wins

- **Delivery window on update.** `createContract` rejected `end < start`;
  `updateContract` did not, so an edit could invert a valid window. Now
  checked against the **effective** post-update values: a PATCH sending
  only `deliveryEnd` is compared against the STORED `deliveryStart`.
  Checking only the submitted pair would have missed the common case.
- **Trim.** `sanitizePlainText` strips markup but does **not** trim, so
  `"   "` passed the required-counterparty check and persisted as a blank
  row title. Now trimmed after sanitising, on both create and update.
- **Blank `key` → null.** `key` sits on `@@unique([tenantId, key])`.
  Postgres does not collide NULLs but *does* collide two `""` rows, so a
  second blank-keyed contract 409'd with nothing an operator could act on.
  `cleanOptionalText` normalises blank → null (also applied to
  `commodity`).

## Files

| File | Role |
|---|---|
| `src/app-layer/domain/contract-status.ts` | **New.** Transition graph, `checkContractTransition` / `formatContractTransitionError`, `CONTRACTED_COMMITMENT_STATUSES` + the rationale for each exclusion. |
| `src/lib/validation/query-params.ts` | **New.** `parseCsvEnumParam` — CSV multi-select param → validated enum array, 400 on any invalid member. |
| `src/app-layer/usecases/contract.ts` | Array-typed filters + `{ in: [...] }`; lifecycle guard; effective-window check; trim; blank-key normalisation. |
| `src/app-layer/usecases/portfolio-grain.ts` | Contract rollup restricted to the live commitment statuses; docstring + DTO comments updated to match. |
| `src/app/api/t/[tenantSlug]/grain/contracts/route.ts` | Parses `status` / `type` as validated CSV enum lists. |
| `…/grain/contracts/ContractsClient.tsx` | `loadError` → `EntityListPage` table `error`. |
| `…/grain/bins/BinsClient.tsx` | Same. |
| `…/grain/yield/YieldClient.tsx` | Same. |
| `…/grain/costs/CostsClient.tsx` | Same, across all three dimension tables. |
| `messages/{en,bg}.json` | `loadFailed` for grain.contracts / bins / yield / costs. |
| `tests/guards/rendered-coverage-floor.test.ts` | Floor 201 → 210 for the new rendered coverage. |

## Decisions

- **Type the filter, don't validate-and-cast.** The 500 existed because a
  cast let a `string` masquerade as an enum. Making `ContractListFilters`
  hold real enum arrays means the compiler enforces the boundary; the
  route-level zod validation is then the only place a raw string is
  handled. Validation alone (leaving the scalar signature) would have
  fixed this bug without preventing the next one.
- **`{ in: [] }` is not "no filter".** Guarding on `.length` matters: an
  empty facet array must widen back to "all". This is the same
  empty-table-that-looks-like-truth failure the whole change is about,
  one layer down.
- **Error gated on "nothing to show" rather than raised unconditionally.**
  Blanking good rows because a background poll failed would trade one
  dishonest screen for another. The honest rule is: show what you have,
  and say so when you have nothing.
- **A 400 for a bad filter member, not a silent drop.** Diverges from the
  `parseKinds` precedent in `traceability/graph`, on purpose — a widened
  result set presented as the operator's selection is a lie; a 400 is not.
- **`SETTLED` excluded from contracted tonnes.** The judgment call in
  flag 3. Including it makes the headline a lifetime total that only grows
  and is dominated by history within a season or two; excluding it makes
  the number mean "what we are on the hook for". The exclusion is
  documented at the constant, not just here, because that is where the
  next reader will be standing.
- **No-op transitions allowed.** Copying `checkWorkItemTransition`'s
  no-op rejection verbatim would have broken every edit of a terminal
  contract — the form always re-sends status. The divergence is asserted
  in a test so a future "make these consistent" PR fails loudly rather
  than shipping the breakage.
- **Delivery window checked against effective values.** The naive fix
  (validate the submitted pair) passes the obvious test and misses the
  real case, since the form can PATCH one edge.
- **Sanitiser mock replaced with the real thing where behaviour is the
  claim.** The pre-existing whitespace-counterparty test used
  `mockReturnValueOnce('')`, which proved a branch existed while `"   "`
  still sailed through in production. Tests that assert trim/strip
  behaviour now swap in `jest.requireActual` for a single call and first
  assert the premise (`realSanitize('   ') === '   '`).
- **Left out of scope, flagged instead:** `/grain/yield-records` reads
  `seasonId` / `locationId` as scalars while its toolbar declares both
  `multiple: true`. Because those columns are `String` (not enums) Prisma
  does not throw — selecting two seasons silently returns zero rows
  instead of 500ing. Same defect class, no crash, not in this diff's
  scope; the fix is `parseCsvEnumParam`'s non-enum sibling plus
  `{ in: [...] }` in `listYieldRecords`.
