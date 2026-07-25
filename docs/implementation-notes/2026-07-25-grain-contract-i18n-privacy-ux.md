# 2026-07-25 — Contracts: one enum source, no encrypted terms in list reads, the contract number, and field-level UX

**Commit:** `<pending>` fix(grain): collapse the contract enum, stop listing encrypted terms, surface the contract number

Five clusters on the contracts surface. The first two are correctness
and confidentiality; the rest are the difference between a form a farmer
can use and one they work around.

## 1 · The i18n breach, and the three copies behind it

`ContractFormModal` built its Type/Status dropdowns from
`CONTRACT_STATUS_LABELS` / `CONTRACT_TYPE_LABELS` — hardcoded English
literals in `filter-defs.ts`. A Bulgarian user saw a translated badge in
the table, a translated chip in the filter bar, and then an **English
dropdown in the form that edits them**.

Behind it sat a worse problem: the five-member enum existed in **three**
places.

| Copy | Consumer | bg "SETTLED" | bg "CANCELLED" |
|---|---|---|---|
| `CONTRACT_STATUS_LABELS` (literals) | form modal | *(English)* | *(English)* |
| `grainEnums.statusSettled…` | filter chip | Уредена | Отказан |
| `ag.status.contract.*` | table badge | Уред**ен** | Отменен |

The Bulgarian catalogue had already drifted: the chip and the badge
disagreed **for the same row, two columns apart**. Key-parity between
locales cannot catch that — both keys exist in both files; they just
disagree with each other.

Collapsed to one: **`ag.status.contract.<MEMBER>`**, the keys
`<AgStatusBadge>` already resolved. Chosen over the `grainEnums`
flattening because it is keyed by enum MEMBER, so a value maps to a label
without a switch. The member LIST comes from
`ALL_CONTRACT_STATUSES` / `ALL_CONTRACT_TYPES` in the domain module, so
adding a status to the Prisma enum surfaces in every dropdown without a
second edit. The literals and the `grainEnums` duplicates are deleted.

`buildContractFilters` now takes two translators — `grainEnums` for the
FACET labels ("Status"), `ag` for the MEMBER labels — which is honest
about the two different things being named.

**Why it slipped: the ratchet only scanned `.tsx`.** The leak lived in a
`.ts` config module, invisible by construction. The walk now covers
`.ts`, scanning for user-facing OBJECT PROPERTIES (`label:`,
`description:`, `placeholder:`) — the exact shape of a filter-def or
column config.

That immediately surfaced **~380 pre-existing offenders** across admin
pages and widget dispatchers. Rather than fold them into one inflated
number, the two classes ratchet **separately**: the JSX floor stays at
20, and `CONFIG_PROP_BASELINE = 391` locks the config class so it can
only fall. Same reasoning the repo applies to `as any` — a large existing
debt makes a hard error infeasible, so the ratchet is the enforcement.

It also caught a live leak in the file being fixed: `buildContractFilters`
overrode `label` and `options` but never `description`, so the facet
description rendered in English regardless of locale. Now translated.

## 2 · Encrypted contract terms were in every list response

`listContracts` had no `select`, so a `findMany` returned **every**
column — including `terms` (≤20 000 chars) and `pricingNotes`, the two
Epic-B encrypted columns, **decrypted by the read middleware**, for up to
500 rows. Into the SSR payload, into the client query cache, and into the
browser memory of every READER and AUDITOR — none of whom have any
surface that renders them, since the only renderer is the edit modal
behind `canWrite`.

Encrypting a column at rest and then broadcasting it to everyone who can
open a list is not confidentiality.

Fixed with an explicit `LIST_SELECT` that omits both. The full row is
fetched on demand by `getContract` when the edit modal opens — which
gives the previously-dead `GET /grain/contracts/[contractId]` route its
first caller, closing the over-fetch and the dead route together.

**Fork — should read-only roles get a read-only detail view?**
Deliberately **not** in this change. The fields are the negotiated
commercial terms and the pricing basis; "READER can see everything, just
not edit it" is a policy decision about commercially-sensitive data that
belongs to whoever owns the tenant's access model, not to a defect-fix
PR. What changed here is only that the data stops going to people who had
no way to see it anyway. The seam is ready: `getContract` already
authorises with `assertCanRead`, so exposing a read-only panel later is a
UI change, not a data-flow one — and if the answer is instead "these
fields are write-role-only", that wants an explicit policy check in
`getContract`, which is equally a one-liner. Flagged for the product
owner rather than decided silently.

## 3 · The contract number

`Contract.key` — the reference printed on the paper the farmer is
holding, carrying a real `@@unique([tenantId, key])` — had no form field,
no column, and no search. The client type declared it and never used it.

Added to the create/edit form, the list (monospace, since it is an
identifier to compare character by character), and search.

Two structural fixes alongside:

- **The unique index is now soft-delete-aware.** `WHERE deletedAt IS
  NULL`, matching the `Asset.name` / `Policy.slug` precedent. Deleting a
  contract used to burn its number permanently: re-entering the same
  reference (a re-issued or corrected contract — the ordinary case) hit a
  409 the operator could neither see nor diagnose, because the colliding
  row was invisible to them.
- **`Contract` joined the soft-delete and retention registries.** It
  carries the full trio (`deletedAt` / `deletedByUserId` /
  `retentionUntil`) and its usecase soft-deletes, but it was in neither
  `SOFT_DELETE_MODELS` nor `RETENTION_MODELS` — so `retentionUntil` was
  written by nothing and read by nothing. A grain contract holds
  commercial terms and a counterparty name; it is exactly what a
  retention policy is for.

## 4 · Field-level UX

- **The delivery WINDOW, not just its start.** The list rendered
  `deliveryStart` alone, hiding the deadline that actually matters. Now
  `formatDateRange(start, end)`.
- **Buyer / Supplier, not "Counterparty".** The schema has always known
  this is a BUYER on a SALE and a SUPPLIER on a PURCHASE, and `type` is
  in hand at render time. Each row labels its own party; the form field
  re-labels itself as the type changes.
- **Currency is an ISO-4217 picker.** It was free text, and the org
  rollup labels a whole farm's money with the first contract's raw
  string — so "eur", "EUR" and "€" were three currencies to every
  rollup. A short list of the currencies grain is actually traded in
  here, not all ~180 codes. An unrecognised stored value is preserved at
  the top of the list rather than silently rewritten on the next
  unrelated edit.
- **PLANNING-off is said out loud.** The season picker previously showed
  a lone "No season" whether the module was off, the request failed, or
  no seasons existed. Three distinct states, three distinct hints, and
  the picker disables itself when the module is off.
- **Jargon tooltips** on "Settled" (= delivered *and paid*) and on the
  pricing-notes field ("basis").

## 5 · Polish

- **The error banner showed the wrong thing every time.** The API body is
  `{ error: { code, message, details? } }`; the modal tested
  `typeof data.error === 'string'`, which is always `'object'`, fell
  through to `data.message` (undefined), and showed a generic string —
  discarding the clean 409 on a duplicate contract number and every
  per-field validation issue. Now reads `error.message` and appends
  `details` when present.
- **Terms got a usable height** (2 rows → 8 for a 20 000-char field).
- **The 500-row cap is no longer silent.** The response carries
  `totalCount` + `truncated`, and the page says "showing the first N of
  M". The count query runs ONLY when the page came back full — in the
  ordinary case the page length is the total.
- **Search moved server-side** (debounced 300 ms via a new shared
  `useDebounce`). The in-memory filter only ever saw the 500-row page, so
  a match on row 501 was invisible: a wrong answer delivered
  confidently. Search covers `counterparty` / `commodity` / `key` — all
  plaintext. It deliberately does NOT cover `terms` / `pricingNotes`,
  which are encrypted at rest: a `contains` there would match ciphertext
  and silently return nothing.
- **Numbers use a pinned locale.** `toLocaleString(undefined)` resolves
  to the *host* locale, which differs between the Node render and the
  browser hydrate — a hydration mismatch waiting for the first visitor
  whose OS is not en-US. Replaced across all four grain clients and the
  org portfolio with `formatDecimal`.
- **`ContractsClient` joined the axe sweep** in `ag-pages-a11y`, with
  fixture rows covering the branchy cells (window badge, progress bar,
  unpriced value).
- **Cross-links between the grain pages.** Contracts, Yield, Bins and
  Costs are one workflow reachable only via the sidebar. A plain link row
  — not a tab bar, since these are separate pages with their own URLs and
  filters.

## Decisions

- **`ag.status.contract` as the survivor, not `grainEnums`.** Member-keyed
  beats flattened: `ag.status.contract[value]` needs no switch, and the
  table badge already resolved it, so the surface with the most
  consumers stayed put.
- **Two ratchet classes, not one number.** Merging ~380 pre-existing
  config-prop offenders into the JSX baseline would have destroyed the
  JSX ratchet's precision. Separate floors keep both meaningful.
- **The list select is an explicit allowlist, not `omit`.** A new column
  should default to NOT being broadcast; with `omit` it would ship the
  moment it is added and nobody would notice.
- **Read-only detail view deferred, and said so.** See the fork above —
  a data-visibility policy for commercially-sensitive fields is the
  product owner's call.
- **Search excludes the encrypted columns by design.** Including them
  would look thorough and return nothing, which is worse than a narrower
  search that works.
- **`useWatch` over `watch()` in the modal.** `watch()` returns a fresh
  function each render, so its result is not memoization-safe in a
  `useMemo` dep array — the currency picker feeds exactly that.
- **The count query is conditional.** Running it on every list read to
  populate a hint that fires for a handful of tenants would be a
  permanent cost for a rare message.
