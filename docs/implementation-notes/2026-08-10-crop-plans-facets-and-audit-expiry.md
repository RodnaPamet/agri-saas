# 2026-08-10 — crop-plans multi-select facet, a blind route-parity guard, and audit-exemption review-date expiry

**Commits** (one per fix, on `fix/crop-plans-facets-and-audit-expiry`):
- `4c52b93d` fix(planning): crop-plans multi-select status facet no longer 500s
- `0e3306ef` fix(guards): resolve nested routes in multi-select-facet-route-parity
- `0910e6c0` fix(security): audit-exemptions fails once an exemption's review date passes
- `f3f9247c` fix(rag): corpus ingestion resolves embeddings via getEmbeddingProvider

## Design

Four independent fixes, three found together during a pass over the
Epic 53 multi-select-facet bug class, a fourth (RAG embeddings) found
separately while inspecting production and folded in here rather than
opening a second note for one call site.

### 1 — crop-plans `status` facet 500s the list page

`CropPlansClient.tsx` declares `status` as a `multiple: true` facet
(`filter-defs.ts`), so `toApiSearchParams` comma-joins a two-value
selection into `?status=DRAFT,ACTIVE`. `GET
/api/t/[tenantSlug]/planning/crop-plans` read that with a bare
`z.string().optional()` and forwarded it straight through to
`listCropPlans`, which handed it to Prisma as an enum EQUALITY:

```ts
...(filters.status ? { status: filters.status as Prisma.EnumCropPlanStatusFilter['equals'] } : {})
```

Prisma throws `PrismaClientValidationError` on `status: "DRAFT,ACTIVE"`,
the route 500s, and `EntityListPage`'s empty state renders — a crash
presented to the farmer as "you have no crop plans". This was live.

Fixed to the pattern already established for `exchange/listings`,
`grain/contracts`, and `knowledge`: the route schema parses `status`
with `csvEnumField(z.nativeEnum(CropPlanStatus))` (validates every
member, 400s on an unknown one), the usecase's filter field is typed
`CropPlanStatus[]` (new `CropPlanListFilters` interface — no more
`string` + `as` cast), and the query is `{ status: { in: [...] } }`
guarded on `.length` so a CLEARED facet omits the filter instead of
emitting `{ in: [] }` (which matches nothing and would empty the table
on clear). `seasonId` / `cropTypeId` are single-select ids in this
page's filter-defs (`multiple` defaults to `false` for both) — plain
equality is correct for them and was left alone.

### 2 — the guard that should have caught it was looking in the wrong place

`tests/guards/multi-select-facet-route-parity.test.ts` exists
specifically to track this bug class, but `NO_SIBLING_ROUTE` hard-
excluded `planning` — its check only ever looked for a literal sibling
`planning/route.ts`, which doesn't exist (the real route is nested at
`planning/crop-plans/route.ts`). Worse: that "check one exact sibling
path, silently skip if absent" logic meant the exclusion list was
partly redundant with a *silent* pass baked into the walker itself —
`exchange` and `tests` behaved identically whether or not they were
listed.

`findRouteFiles(dir)` replaces the single-path check with a recursive
walk of every `route.ts` under the page's whole API subtree.
`planning` now resolves for real (finds `crop-plans/route.ts`) and so
does `exchange` (finds `listings/route.ts`) — both dropped from
`NO_SIBLING_ROUTE`. `tests` was dead weight: the compliance "control
exoskeleton" page it referred to was deleted in #501 and no filter-defs
case has matched it since. Only `grain/yield` survives the cut, with a
written reason: its route lives at the DIFFERENTLY-NAMED sibling
`grain/yield-records/`, not nested under `grain/yield/` at all — a
name mismatch a directory walk can't bridge, verified by hand instead.

A new `it('the NO_SIBLING_ROUTE backlog has no stale entries', …)`
mirrors the existing `KNOWN_UNFIXED` staleness check, so a future
`grain/yield`-shaped exclusion that later resolves (or whose page is
deleted) fails CI instead of sitting there unexamined forever.

Mutation proof (the ticket's explicit ask — "a guard that passes
because it looked in the wrong place is worse than no guard"): a
`describe('planning.status — nested resolution + mutation proof', …)`
block asserts (a) there genuinely is no `planning/route.ts`, (b) the
recursive walk reaches the nested `crop-plans/route.ts`, (c) today
`planning.status` resolves as CSV-parsed through it, and (d)
re-synthesizing the EXACT pre-fix route shape (`status:
z.string().optional()`, forwarded verbatim) makes `parsesCsv` return
`false` — i.e. if the crop-plans fix above were ever reverted, the
real `it.each` case for `planning.status` would fail CI rather than
silently pass.

### 3 — audit-exemption `review` dates were write-only

`scripts/audit-exemptions.mjs`'s `EXEMPT` entries carry a `review`
date, but it was only ever printed on a passing run — never compared
against "today". An exemption could outlive the date its own author
promised to revisit it, so an accepted-for-now risk could silently
become a forgotten one forever.

`classifyExemptions(exempt, found, today)` is a new pure function
alongside the existing unexplained/stale logic: an entry is `expired`
when its advisory still appears in the audit AND `review` has passed.
Boundary rule: `review === today` still passes — the entry is *due*
for review, not yet overdue; it expires the day *after*. (First
implementation compared the calendar `review` date directly against
`new Date()`, i.e. "right now" — that made an entry expire the moment
the clock ticked past midnight UTC on its own review day. Fixed by
truncating "today" to a UTC calendar date before comparing.) The CLI
reports `EXPIRED` entries with a distinct message from `STALE` (fix
the advisory / delete the entry vs. re-argue and re-date) and fails
the build the same way.

Two test-only env overrides — `AUDIT_JSON_OVERRIDE` (fixture audit
report) and `EXEMPT_OVERRIDE` (fixture exemption list) — let
`tests/unit/audit-exemptions.test.ts` drive the real script
end-to-end via subprocess (`spawnSync('node', [SCRIPT])`, the same
convention `sync-chart-version.test.ts` uses for the repo's other
`import.meta.url`-guarded CLI script) without touching the real
`EXEMPT` array or shelling out to a live `npm audit`. Neither override
is read outside a test invocation.

### 4 — RAG global-corpus ingestion still resolved embeddings through the completion provider

Found while inspecting production, same bug class as #496
(`docs/implementation-notes/2026-08-07-rag-embedding-provider-split.md`):
`scripts/rag/corpus.ts:647` still called `getAiProvider().embed(...)`.
#496 split the provider role precisely so embedding calls never
resolve through the completion backend (`AI_BACKEND=claude` has no
embeddings endpoint, and even on the default backend the completion
and embedding roles can point at different hosts) — it converted
`retrieve()` and the `embed-chunks` job to `getEmbeddingProvider()`,
but this ingestion script's call site was missed. On the production
VM `AI_BACKEND` is unset, so `getAiProvider()` resolves to the schema
default `AI_BASE_URL=http://localhost:11434/v1`, where nothing
listens — `npm run rag:ingest` cannot currently succeed there, and
production holds zero knowledge chunks as a result.

The split's invariant only holds if EVERY embedding call site uses
`getEmbeddingProvider()` — a single surviving `getAiProvider().embed()`
is enough to reintroduce the exact defect #496 fixed, just on a
different code path. Fixed by importing `getEmbeddingProvider`
instead (same relative-import style the file already used) and kept
throwing on failure, matching `embed-chunks`'s (not `retrieve()`'s)
tradeoff: this is a one-shot ingestion script with an operator
watching, so a silent degrade would write chunks with a missing
embedding and report success, leaving retrieval quietly keyword-only
with nobody told. A repo-wide grep for any other surviving
`getAiProvider().embed` (or bare `.embed(` not routed through
`getEmbeddingProvider()`) found none — this was the only miss.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/crop-planning.ts` | `CropPlanListFilters.status` typed `CropPlanStatus[]`; query uses `{ in: [...] }` guarded on `.length` |
| `src/app/api/t/[tenantSlug]/planning/crop-plans/route.ts` | `status` query param parsed with `csvEnumField(z.nativeEnum(CropPlanStatus))` |
| `tests/unit/crop-planning.test.ts` | New coverage: multi-value status → `{ in: [...] }`; cleared facet → filter omitted |
| `tests/guards/multi-select-facet-route-parity.test.ts` | `findRouteFiles` recursive walk replaces the single-sibling-path check; `NO_SIBLING_ROUTE` reduced to `grain/yield`; new staleness check for that list; mutation-proof `describe` block for `planning.status` |
| `scripts/audit-exemptions.mjs` | `classifyExemptions` adds the `expired` bucket; `AUDIT_JSON_OVERRIDE` / `EXEMPT_OVERRIDE` test hooks; CLI guarded behind an `import.meta.url` main-module check |
| `tests/unit/audit-exemptions.test.ts` | New file — subprocess-driven coverage of unexempted / stale / expired / valid-future-date / due-today-not-overdue, plus a real (no-override) sanity run |
| `scripts/rag/corpus.ts` | `ingestGlobalCorpus` calls `getEmbeddingProvider()` instead of `getAiProvider()` |

## Decisions

- **Only `status` needed the crop-plans fix.** `seasonId` /
  `cropTypeId` are single-select in `planning/filter-defs.ts`
  (`multiple` defaults to `false`) — a plain string equality is
  correct for them, so they were left untouched rather than
  speculatively "fixed" into arrays they don't need.
- **Recursive walk, not a page→route alias map.** `planning` and
  `exchange` are genuinely NESTED under their page directory, so a
  subtree walk resolves them for real with no extra bookkeeping.
  `grain/yield` is a same-level SIBLING rename
  (`grain/yield-records/`), which a directory walk structurally can't
  bridge — adding a tiny alias map for one entry was judged more
  machinery than the one documented exception is worth, especially
  since the new staleness check will flag it the moment that stops
  being true (e.g. if the route is ever renamed to match).
  A page whose API directory doesn't exist at all now requires an
  explicit `NO_SIBLING_ROUTE` (or `KNOWN_UNFIXED`) entry — the old
  "file not found → silently return" branch is gone, so a *future*
  page/route name mismatch can't recreate this exact blind spot
  unnoticed.
- **`review === today` passes, not fails.** An exemption due for
  re-review today is not yet overdue — a same-day CI run shouldn't
  block a merge for a review that literally hasn't come due. It
  expires starting the next calendar day.
- **`EXEMPT` stays literally unchanged (still empty).** The
  `EXEMPT_OVERRIDE` test hook is additive — it lets the test drive
  the real script's classification logic through fixture data without
  touching the production array or its accompanying rationale
  comment, per the constraint that this fix not alter exemption
  entries or the audit level.
- **`findAdvisories` / `classifyExemptions` are exported but not
  directly imported by the test.** ts-jest's CommonJS transform
  doesn't support `import.meta`, so any direct `import` of this file
  fails regardless of which export is consumed (same reason
  `sync-chart-version.mjs` is only ever spawned, never imported, in
  its own test). The exports exist for in-file clarity (separating
  the pure decision from `main()`'s I/O + reporting); the test drives
  them exclusively through the CLI subprocess.
- **corpus.ts keeps throwing on embed failure**, matching
  `embed-chunks` rather than `retrieve()` — see #496's note for the
  general rule: a request path with a safe fallback (keyword search)
  degrades, a one-shot ingestion script with an operator watching
  does not.
