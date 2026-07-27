# 2026-07-27 — Yield page: filters that filter, pickers that distinguish

**Commit:** _(this PR)_ — third of the grain roadmap, after
`2026-07-26-harvest-reconciliation.md` and
`2026-07-26-yield-comparable-numbers.md`.

## 1. Multi-select filters returned nothing

Both facets declare `multiple: true`, the shared filter layer comma-joins,
and the route read a scalar — so `?seasonId=a,b` became `seasonId = "a,b"`.

The interesting part is the **asymmetry with the enum case**. An enum param
handed a comma-joined string throws `PrismaClientValidationError` — a 500,
which at least reads as broken. An ID param is a plain `String` column, so
Prisma accepts it and matches **nothing**: the table renders "No yield
records match your filters", which a farmer reads as *this farm harvested
nothing in those two seasons*. A wrong answer that looks like an answer is
the worse failure, and it is the one that had no test.

`parseCsvIdParam` is the non-enum sibling of the existing
`parseCsvEnumParam`. IDs cannot be validated against a value set the way
enum members can, so its checks are structural (non-empty, bounded length,
bounded count) — enough to keep a malformed param out of the query layer
without pretending to know which IDs exist. The tenant-scoped `where`
already decides that, and an ID from another tenant simply matches no row.

`/grain/contracts` turned out to be **half-fixed already**: `status` and
`type` had been migrated to `parseCsvEnumParam`, but `seasonId` was still
the scalar read — the quiet variant of the same bug, left behind because it
never produced the 500 that got the others noticed.

An empty selection is covered explicitly: it must omit the filter, not
become `IN ()`, which is the same empty-table failure in a new costume.

## 2–3. Pickers that could not be used

**Plantings** were labelled `Succession {n} · Variety`, and both parts
repeat across crop plans and fields — so the list was a column of identical
"Succession 1 · Winter Wheat" rows. The label now carries field, crop plan
and sow date (`cropPlan: { name }` added to the plantings read for this),
and the list is scoped to the selected field. Plantings with **no** field
stay visible: hiding them would make an unassigned planting unreachable.

**Fields** listed grain bins, because the modal fetched `/locations` with no
`kind`. The repository gap the audit described was **already closed** —
`_buildWhere` supports `kind` and the route parses it — so the fix was
simply for the caller to ask (`?kind=FIELD`). Worth recording: the bins then
flowed into the Field facet and the per-field recap, so silos appeared as
places crops had been grown.

## 4. Encrypted valuation notes were broadcast

`valuationNotes` is commercial valuation commentary, encrypted at rest by
the Epic B manifest, and its only renderer is the **write-gated** edit form.
The list decrypted it into every response and inlined it into the RSC
payload — so every READER received commercial text they can never open.

The list projection is now an explicit allowlist rather than an `omit`: a
column added later must default to NOT shipping, whereas with `omit` it
would ship the moment it exists and nobody would notice. The edit form
fetches the field on demand from `GET …/yield-records/{id}`.

The DTO **omits the key** rather than sending `null` — `null` asserts "this
record has no notes", which is a different claim from "not sent on this
endpoint".

**Read-only access was left as it is, deliberately.** Granting readers a
new view of commercially sensitive text is a data-visibility policy
decision, not a defect fix; the same fork was recorded (and deferred to the
product owner) for grain contracts. The API now supports the on-demand read,
so building that view later is cheap.

## 5–6. Module coupling, commodity, and the polish batch

- A GRAIN-only tenant got empty Planting/Season pickers, because both
  sources are PLANNING-gated and the modal never rendered the query error —
  so "no plantings" and "the module that owns plantings is off" looked
  identical, and the fix was invisible. The field now says which.
- **Commodity** is free text, which fragments fast ("Wheat"/"wheat"/"Winter
  wheat" are three commodities to a `GROUP BY`). It pre-fills from the
  selected planting's variety (via `useWatch` — `watch()` returns a fresh
  function each render and is not memo-safe), and gained a facet. The facet
  doubles as a view of how badly the column has fragmented.
- **Search moved server-side.** The in-memory filter only ever saw the
  loaded page, so a match on row 501 was invisible and reported as "no
  results" for a record that exists. It deliberately excludes
  `valuationNotes`: encrypted at rest, so a `LIKE` over it cannot match —
  searching it would look thorough and return nothing.
- **The 500-row cap is no longer silent.** The list read returns
  `{ rows, totalCount, truncated }` (mirroring contracts), counting only
  when the page comes back full, and the page says how many of how many.
- Update and delete now emit `HARVEST_YIELD_RECORDED` + a trace span. A
  corrected or retracted tonnage is news to a rule watching production —
  arguably more than the original, since a figure someone acted on has
  moved. Delete carries `retracted: true` and null tonnage.
- Validation messages are translated and **split three ways**: unparseable
  input, negative, and beyond column precision need three different fixes,
  and one message tells the user something is wrong without saying what.
  Bounds mirror the server so the form refuses what the API would refuse.
- Also: the delete toast names the record (with several deletes in flight,
  "Yield record deleted" gives no clue what Undo restores), URL filters are
  read by the SSR page so a shared filtered link paints filtered on first
  load, and the list GET uses `jsonWithETag`.

## Decisions

- **The list envelope changed shape, and `tsc` did not catch the call
  sites.** `JSON.parse(JSON.stringify(x))` is `any`, so the SSR page kept
  compiling while passing an object where rows were expected. The prop was
  renamed `initialRecords` → `initialPayload` precisely so the type system
  would force every consumer to be visited.

- **The structural adoption test was updated, not deleted.** It asserted the
  literal `initialRecords`; it now asserts the envelope hydration plus two
  new invariants (the truncation notice exists, search goes to the server).

- **`Wheat` does not exist in the nucleo icon set** — the commodity facet
  uses `Apple`, the produce glyph this set actually ships.
