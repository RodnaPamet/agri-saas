# 2026-07-29 — Exchange: one currency, one market

**Commit:** `91c06bbc fix(exchange): make a price mean one thing, and the feed describe the market`

Six defects, one theme: the Exchange was confidently reporting things it had
not measured. A price was relabelled rather than converted. Averages mixed
currencies. Filters and market statistics described the newest 100 offers
nationwide while reading like a census. A module opt-out hid the marketplace
from the tenant and left the tenant's offers on it. And a Bulgarian farmer read
about "Тип" meaning two different things on adjacent screens, in a region
called "Stara Zagora".

## The euro decision

`ExchangeMap.tsx` stamped `PRICE_UNIT = '€/t'` onto every price chip while the
card beside it rendered the row's stored `priceCurrency`. A 320 BGN listing
therefore read **320 €/t** on the map and **320 BGN/t** in the list — the same
number under two labels ~1.96× apart in real value. There were three ways out:

1. **Render the stored currency everywhere.** Honest, and one line. But it
   leaves the marketplace holding three denominations with no way to compare
   two offers, which is what a marketplace is for.
2. **Convert at a live FX rate.** Turns every historical price into a moving
   number and makes the platform an unwitting FX source of truth.
3. **Convert BGN → EUR once, at the legally fixed rate (chosen).**

(3) is safe here for a reason that does not generalise: the lev has been pegged
at **exactly 1.95583 BGN = 1 EUR** since 1999, and euro adoption uses that as
the *irrevocable* conversion rate. It is not a quote; it is arithmetic. So the
migration is exact and never needs revisiting.

The corollary is the part worth remembering: **USD was deliberately left
alone.** It floats. There is no rate the migration could bake in that would
still be true tomorrow, so a USD row keeps its amount, keeps its label, renders
with its own symbol wherever it appears — and is excluded from every
cross-listing aggregate. Relabelling it would have been the original bug with a
different pair of currencies.

`priceCurrency` therefore **stays**. Dropping it would leave the table unable to
express the rows that exist.

```
                       ┌───────────────────────────────┐
 legacy BGN rows ─────►│ migration: ROUND(p/1.95583,2) │──► EUR, exact
                       └───────────────────────────────┘
 legacy USD rows ─────────────── untouched ───────────────► USD, own label
 new listings ────► Zod z.literal('EUR') ─────────────────► EUR, by construction

                    src/lib/exchange/currency.ts
                    ├─ formatPricePerTonne()  every price surface
                    ├─ isAggregatable()       may this row join a mean?
                    └─ isAggregatableWith()   do these rows share a currency?
```

`isAggregatable*` is the single predicate behind the ticker average, the map's
per-group price chip and the national ★ best-price ring. A group whose priced
members do not share one currency shows **no** price rather than a meaningless
one; the marker still renders, because the tonnage and the crop are true
regardless.

## The module opt-out decision

`listActiveListings` had no seller-side module check, while
`PATCH /exchange/listings/[id]` gated on the *caller's* module. So a tenant that
switched EXCHANGE off kept every listing public **and** lost the only endpoint
that could take them down. Three candidate fixes:

- **Auto-withdraw on disable.** Rejected. A settings toggle that silently
  bulk-mutates public artefacts is surprising, and unrecoverable if the tenant
  re-enables the module ten minutes later.
- **Read-time exclusion only.** Fixes the public harm, including for rows
  already orphaned, but leaves the seller unable to tidy up — and the moment
  they re-enable, stale ACTIVE listings pop back onto the map.
- **Both (chosen).** Exclude at READ time, and exempt the WITHDRAW path.

The exemption needed a rule, not an exception. The one adopted:

> **The module toggle governs PARTICIPATION in the marketplace — browsing,
> posting, inquiring, marking a sale. It does not govern CUSTODY of rows you
> already posted.**

That draws a clean line through the surfaces:

| Surface | Gated? | Why |
| --- | --- | --- |
| `GET /exchange/listings`, `/exchange` page | yes | browsing is participation |
| `POST /exchange/listings`, inquiries, `/my-interests` | yes | so is posting and reaching out |
| `PATCH … {action:'FULFILLED'}` | yes | a claim about a sale, feeds "sold" stats |
| `PATCH … {action:'WITHDRAWN'}` | **no** | custody: how you clean up |
| `GET /exchange/my-listings`, `/my-listings` page | **no** | custody: the only place to find what to withdraw |

Gating the custody surfaces is what made the defect *unrecoverable* rather than
merely wrong — the group-`layout.tsx` `requireModule` bounced the seller away
from the one page listing the offers they needed to retract. The gate moved
from the layout onto the participation pages.

The exclusion list is read RLS-FREE (`runInGlobalContext`): `TenantModuleSettings`
is tenant-scoped, so under the viewer's own context it would return at most the
viewer's row and the exclusion would silently do nothing. The read selects
`{ tenantId: true }` and nothing else. A row exists only for a tenant that
customised its module list, so the set is small by construction; if it ever
saturates `MODULE_OPTOUT_TAKE`, the fix is a denormalised flag on the listing,
not a bigger number.

## Files

| File | Role |
| --- | --- |
| `src/lib/exchange/currency.ts` | **new** — the currency policy: fixed rate, EUR-only writes, aggregation predicates, one formatter |
| `prisma/migrations/20260729120000_exchange_euro_denomination/` | one-shot BGN→EUR conversion at 1.95583 + `DEFAULT 'EUR'` |
| `prisma/schema/exchange.prisma` | `priceCurrency @default("EUR")` + why the column stays |
| `src/app-layer/schemas/exchange.schemas.ts` | `z.literal('EUR')` — the write path cannot reintroduce a second currency |
| `src/app-layer/repositories/exchange.ts` | array-shaped facets, cursor pagination, `listTenantIdsWithModuleDisabled`; dead `listInquiriesForSeller` deleted |
| `src/app-layer/usecases/exchange.ts` | seller-module exclusion (feed + deep link), quota inside the create's own tx, expiry mirrored into `createInquiry`, single `notFound` oracle |
| `src/app/api/…/exchange/listings/route.ts` | parses the facets + cursor; returns `{ rows, nextCursor }` |
| `src/app/api/…/exchange/listings/[listingId]/route.ts` | WITHDRAW exempted from the module gate |
| `src/app/api/…/exchange/my-listings/route.ts` | custody read, module gate removed |
| `src/app/t/…/exchange/{layout,page,my-interests/page,my-listings/page}.tsx` | gate moved off the group layout onto the participation pages |
| `src/components/exchange/ExchangeMap.tsx` | `PRICE_UNIT` deleted; per-row currency; single-currency group averages + best-price ring; localized oblast + tonne glyph |
| `src/app/t/…/exchange/ExchangeClient.tsx` | filter state is the SWR key; `useCursorPagination` + Load more; EUR-only ticker with disclosure; Sheet status + disabled interest |
| `src/app/t/…/exchange/CreateOfferModal.tsx` | currency picker removed; seller-name consent copy corrected |
| `src/app/t/…/exchange/my-listings/MyListingsClient.tsx` | per-action busy key, inquiry `createdAt`, module-off banner |
| `src/app/t/…/exchange/my-interests/MyInterestsClient.tsx` | own-currency price, localized oblast, inquiry `createdAt` |
| `src/lib/geo/bulgaria-regions.ts` | `localizedRegionName` + `regionCodesMatchingName` |
| `src/lib/billing/entitlements.ts` | optional `tx` on `assertWithinLimit` so the quota check and the insert share one transaction |
| `messages/{en,bg}.json` | every string above, both locales; Bulgarian terminology settled |

## Decisions

- **The feed's wire shape is now always `{ rows, nextCursor }`.** The journal
  precedent keeps a bare-array branch for its offline outbox; the Exchange has
  no such consumer, so one shape beats two. `ExchangeClient` still tolerates a
  bare array on read — the SWR cache is disk-backed (localStorage + IndexedDB),
  so the first load after this deploy can hand back a payload cached under the
  old contract, and spreading `undefined.rows` would blank the page rather than
  degrade it.

- **Free-text search is ANDed, never assigned to `where.OR`.** The expiry
  predicate is itself an `OR`; a second root-level one would REPLACE it and
  silently resurrect lapsed listings the moment somebody typed in the search
  box. There is a regression test for exactly this.

- **Search resolves Bulgarian region names to codes.** Rows persist the ENGLISH
  oblast name as a stable, locale-independent record, so a farmer searching
  "Пловдив" would otherwise match nothing. `regionCodesMatchingName` turns the
  term into codes and ORs them into the predicate; display goes through
  `localizedRegionName` everywhere.

- **Commodity facet options come from an UNFILTERED page.** Deriving them from
  the displayed rows was fine while filtering was client-side over the whole
  fetched array; now that the server answers the filtered query, the displayed
  rows *are* the selection, so a farmer who picked "Wheat" would find the
  dropdown collapsed to "Wheat" with no way back. The facet read uses a
  filter-free SWR key, which is byte-identical to the feed's key when no facet
  is active — SWR dedupes it to zero extra requests, and only a filtered view
  pays for the second read. Selected values are unioned in so a choice can
  never vanish from its own dropdown.

- **The accumulator reseeds on CONTENT, not on the `data` reference.** A
  reference-keyed effect deadlocks against any SWR-shaped source that returns a
  fresh object per render (reseed → re-render → fresh object → reseed). Real
  SWR keeps `data` stable between revalidations so it would not bite in
  production — which is exactly what makes it a bad thing to depend on. The
  rendered test's mock returns a new object per render and caught it.

- **The ticker discloses both of its limits.** It says how many priced offers
  it left out of the average because they float, and it says when more offers
  exist beyond what is loaded. Tonnage and province counts are
  currency-agnostic and need no such caveat.

- **Bulgarian terminology, settled.** `side` was "Тип" in the modal and
  "Страна" (reads as *country*) in the filter; `kind` was "Вид" in one and
  "Тип" in the other. Now **`side` = "Тип обява"**, **`kind` = "Вид продукт"** —
  distinct, and both natural in Bulgarian classifieds. `commodity` is **"Стока"**
  everywhere (it was alternating with "Култура", which is also the label for the
  CULTURE *kind*, and is wrong for fertiliser or seed). `region` is **"Област"**
  (the actual administrative unit), never "Регион". The tonne glyph is the
  cyrillic **`т`** in Bulgarian and latin `t` in English, sourced from one
  `unitTonne` key per namespace — including the canvas chips, which cannot go
  through JSX.

- **The seller-name hint was inverted, not merely vague.** It promised
  `Blank = your farm name`; blank actually renders "Anonymous farm". Corrected,
  and moved from `hint` (hover-only `InfoTooltip`) to `description`, matching
  the #452 rule that a statement about what strangers will see has to be read
  rather than hovered. The unused `defaultSellerName` prop — which existed only
  to fill that hint, and which no caller ever passed — is gone.

- **Accept stays one click. Deliberately, not by omission.** #452 argued that
  the seller consents by typing a contact into the listing, that the accept
  surface already discloses what it shares *before* the click, and that the
  destructive-vocabulary convention puts confirmation on the *decline* path
  where the irreversibility is. That reasoning still holds and this PR follows
  it. The genuine defect on that row — Accept and Reject both bound to
  `busy === iq.id`, so clicking one spun both on the single pair of buttons
  whose outcomes are opposite — is fixed: the busy key is now
  `${inquiryId}:${action}`.

- **`?listing=` deep link kept, `listInquiriesForSeller` deleted.** #452 gave
  the deep link a producer (the "View offer" link on My interests), so it is
  live and now also honours the seller-module exclusion. The seller's inbox is
  served by `my-listings` (inquiries nested under each listing); the standalone
  repository + usecase pair had no caller and is removed.

- **The inquiry 404/403 oracle collapsed to one `notFound`.** The guard is
  unchanged and still absolute — only the seller may respond, and the mutation
  still never runs. What changed is that the pair (403 = exists but not yours,
  404 = no such row) no longer lets an outsider confirm the existence of another
  tenant's private buyer↔seller conversations one id at a time.

- **The quota TOCTOU is narrowed, not eliminated.** `assertWithinLimit` takes an
  optional `tx` so the count and the insert share the create's transaction. Under
  READ COMMITTED that shrinks the window from "two round trips and a commit
  apart" to "one statement sequence"; a hard cap would need `SELECT … FOR UPDATE`
  or a DB constraint, and there is now somewhere obvious to put it.

- **What was deliberately NOT done.** No live FX conversion and no
  multi-currency comparison UI — see the euro decision. No auto-withdraw on
  module disable. No facet-count endpoint (the commodity dropdown accumulates
  instead). No infinite scroll: "Load more" is explicit, testable, and does not
  fight the viewport-clamped `ListPageShell` scroll container the page already
  uses.
