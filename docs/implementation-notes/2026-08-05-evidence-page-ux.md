# 2026-08-05 — The evidence page: saying what it does, and doing what it says

**Commit:** `fix(evidence): save what the modal sends, filter what the user picked, count what the table shows`

Six defects on the evidence list page. Four share a shape worth naming: **the
UI and the code agreed on a concept and disagreed on its name**, and every one
of those failures was silent — a 200 response, a rendered table, a toast saying
saved.

## Design

### Two fields the edit modal threw away

The modal sent `description`; the column is `content`. It sent `controlId`;
`UpdateEvidenceSchema` had no such field. The schema is `.strip()`, which is
the right default — it stops clients writing columns nobody validated — and
also completely silent: an unknown key is removed, the parse succeeds, the
route returns 200, the toast says saved.

So editing an evidence description did nothing, and re-assigning evidence to a
different control did nothing, for as long as the modal has existed. Nothing
was broken enough to notice. The request was well-formed; the response was
fine.

A type checker cannot see this: the payload is a `JSON.stringify` of an object
literal on one side of an HTTP boundary and a `z.object` on the other, joined
by nothing but a string. `tests/guards/modal-payload-schema-parity.test.ts`
joins them — every key a modal sends must exist in the schema that receives it.

Re-assignment also gained the tenant check `createEvidence` has always had. It
is a write that crosses entities, so it gets the same gate; otherwise a caller
could attach their evidence to another tenant's control by id.

### Multi-select filters, and why the quiet failure is the worse one

`filterStateToUrlParams` comma-joins a `multiple: true` facet into ONE param.
What the route does with `?status=DRAFT,APPROVED` decides which failure the
user gets:

- `z.enum([...])` rejects it → **400**. At least it is loud.
- `z.string()` accepts it, and `"DRAFT,APPROVED"` reaches Prisma as an equality
  and matches nothing → the page renders its **empty state**. A confident "no
  records match your filters" in answer to a filter that never ran. A wrong
  answer that looks like an answer.

Evidence had one of each: `status` 400'd, `type` lied.

The audit that came out of this found **36 multi-select facets across 14 list
pages, of which two were parsed correctly**. That is a bug class, not a slip,
so the fix is at the layer they all pass through: `csvEnumField` /
`csvIdField` in `query-params.ts` put the contract INSIDE the query schema,
where the facet's shape is declared and where the next person writing a route
will see it.

Evidence is fixed end to end (route → usecase → repository, arrays throughout,
never `string` plus a cast) and is the reference implementation. The other 30
are inventoried in `tests/guards/multi-select-facet-route-parity.test.ts`:
each is either CSV-parsed or listed in `KNOWN_UNFIXED` with the page and facet
named. A new multi-select facet on a scalar-reading route fails CI, and a
stale entry fails too, so the list cannot drift out of describing reality.

Shipping 34 route+usecase+repository changes in one diff would have made this
unreviewable. Listing them makes the remainder **visible** rather than done —
which is the honest state, and better than either pretending or silence.

The `.length` guards in the where-builder are load-bearing in their own right:
`{ in: [] }` matches nothing, so a cleared facet must OMIT the filter rather
than emit an empty `IN` — otherwise removing a filter empties the table.

### One page, three names

| | sidebar | page title |
|---|---|---|
| en | Records | Records |
| bg | Документи | Библиотека с доказателства |

A Bulgarian operator navigated to "Документи" and arrived somewhere titled
"Библиотека с доказателства". The count read "{count} доказателства", the
button said "Добави доказателство".

Standardised on **Records / Записи** — the word English had already chosen for
both nav and title, and the farm-register equivalent in Bulgarian (already used
at `assets.tabEvidence`). Title, nav, counts, loading state, description and
the create button now agree, and the counts became proper ICU plurals in both
locales rather than one flat form.

The action-label guard pins `evidence.addEvidence` to the entity noun; it was
`Evidence` and is now `Record`, updated in the same diff with the reason.

### The uploader chose what the browser would treat the bytes as

`file.type` is the client's claim — the browser's guess, or on a hand-built
multipart request simply a string the caller picked. The upload gated
`isAllowedMime` on it, persisted it to `FileRecord.mimeType`, and the download
path replays that value as the response `Content-Type`.

So: send HTML, declare `text/plain`, pass the allowlist, have it served back
under a type of your choosing. The allowlist is only as good as the claim it
checks.

`mime-sniff.ts` checks the bytes. The declared type is still checked first —
it is free and rejects the obvious cases before reading the file — and then
the bytes decide. A recognisable signature that contradicts the claim wins, and
the resolved type is re-checked against the allowlist, so a file that declared
`text/plain` to get past the gate is stored and served as whatever it really
is, and rejected outright if that is not admissible.

Deliberately a magic-number check and not a parser: it answers `null` for
formats it does not recognise, and the caller reads null as "no opinion", not
"safe". Text-shaped formats have no signature by design, so rejecting on null
would block every CSV. AV scanning is the separate control for file interiors.

### Evidence free text was never sanitised

Epic C.5 puts sanitisation at the usecase layer, before the row is persisted,
because the row is read verbatim by the PDF export, the audit-pack share link,
and any SDK consumer — render-time escaping in one UI protects none of those.
Eight usecases are covered by the D.2 ratchet. `evidence.ts` was not one, and
wrote title, content, category, folder and owner raw.

It slipped through for a structural reason worth recording: that ratchet's
population is *encrypted* models, and `Evidence.content` is deliberately
excluded from the encryption manifest so the repository can search it with
`contains`. Not encrypted → not enumerated → never asked whether it sanitises.
A gap in the population, not in the rule.

`sanitizeOptional` preserves the three-state contract — `undefined` (no change)
and `null` (clear) must survive untouched, or a partial update turns "leave
this alone" into "blank this out".

### Counts that described a different table

The KPI cards counted the whole loaded `evidence` array — archived, expired and
soft-deleted rows included — while the table below rendered `displayEvidence`,
the current retention tab, which on load excludes exactly those. The page
opened saying "Total 40" above a table of 32, and "Draft 6" counting drafts
archived months ago. Clicking a card then filtered the table to a number that
had never matched the card.

The counts now derive from `displayEvidence`, so each card is a true statement
about what is in front of the user.

### A phone could not do the work, and neither could a keyboard

`MobileCardList` omits every column without `meta.mobileCard`. Five of the
evidence table's twelve columns had it. Missing: retention — the axis the
page's own tabs are organised on, so the Expiring tab showed a count but not
which record was expiring — and every action column, including Submit /
Approve / Reject. **The page's entire review workflow did not exist on the
device the operator actually carries.** Retention now takes a `meta` slot and
the review actions take the card's `actions` footer.

The keyboard half was worse and not evidence-specific. A clickable `<tr>` had
`onClick` and nothing else: no focus stop, no key handling. Every list page
that opens a detail sheet or navigates on row click was mouse-only.

Fixed at the primitive, with two decisions:

- **No `role="button"`.** It would replace the row's table semantics, and a
  screen-reader user would lose the column associations that make the row
  readable at all. The row stays a row and gains a focus stop and an
  activation key — the data-grid convention.
- **Space is prevented before activating**, or the page scrolls out from under
  whatever the row opens.

`table.tsx` has **two** row renderers, and `applyFixedLayout` picks between
them. The first edit wired only `ResizableTableRow`, leaving the branch most
list pages actually take untouched — a fix that would have read as done and
changed nothing. `tests/rendered/table-row-keyboard.test.tsx` caught it, which
is precisely why it is a rendered test and not a guard: a guard grepping for
`tabIndex` would have found it in one renderer and passed forever.

## Files

| File | Role |
|---|---|
| `src/lib/schemas/index.ts` | `UpdateEvidenceSchema` gains `controlId`; `content` documented against the label/column trap |
| `src/app/…/evidence/EditEvidenceModal.tsx` | sends `content`, the wire name |
| `src/app-layer/usecases/evidence.ts` | applies `controlId` with a tenant check; sanitises every free-text column; reconciles MIME from bytes |
| `src/lib/validation/query-params.ts` | **new** `csvEnumField` / `csvIdField` — the multi-select contract, in the schema |
| `src/app/api/…/evidence/route.ts` | `type` + `status` as CSV enum facets |
| `src/app-layer/repositories/EvidenceRepository.ts` | filters typed as arrays; `{ in: [...] }` guarded on `.length` |
| `src/lib/storage/mime-sniff.ts` | **new** — magic-number detection + claim reconciliation |
| `src/app-layer/usecases/journal.ts` | same MIME reconciliation on photo upload |
| `src/app/…/evidence/EvidenceClient.tsx` | KPI counts over displayed rows; retention + review actions on the mobile card |
| `src/components/ui/table/table.tsx` | clickable rows keyboard-operable — **both** row renderers |
| `messages/{en,bg}.json` | one name for the page, ICU plurals for its counts |

## Decisions

- **Wire names match the column, labels are free.** "Description" is a fine
  thing to call it on screen; the payload key is `content` because that is what
  it is. Two names for one thing is what caused this.
- **Fix the multi-select bug at the schema, list the rest.** A helper that
  routes compose with is a real fix at the shared layer; a 34-page sweep in the
  same diff would be unreviewable. The inventory makes the remainder visible,
  which is the honest state.
- **Check the claim first, then the bytes.** Checking the declared type is free
  and rejects the obvious cases before the file is read. It is just not
  sufficient on its own, which is the whole point.
- **`null` from the sniffer means "no opinion".** Treating it as a rejection
  would block every text upload; treating it as "safe" would be a lie. The
  caller keeps the claim and the AV scan is the separate control.
- **KPI counts follow the visible table, not the loaded array.** A card that
  describes rows the user cannot see is not a summary of anything.
- **The row keeps its table semantics.** `role="button"` would have been the
  quick way to get keyboard activation and would have cost screen-reader users
  the column associations. A focus stop plus a key handler costs nothing.
