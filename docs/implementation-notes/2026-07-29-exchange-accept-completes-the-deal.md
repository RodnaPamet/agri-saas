# 2026-07-29 — Exchange: Accept completes the deal

**Commit:** `55c2a231 feat(exchange): make Accept complete the deal, and close the states it left open` (backend)
plus the client/consent half landed in the same PR.

The marketplace stopped at "Accept". Two farms who agreed had no way to reach
each other: `respondToInquiry` flipped a status and returned, the models
carried no contact fields at all, and the buyer's only signal was a badge on a
page they had to remember to revisit. Meanwhile the inquiry email already
promised *"Contact details are shared only when you choose to respond."* — a
sentence describing behaviour no code performed.

## The fork

Two designs close that gap. This one is worth writing down because the
rejected option is the one that sounds safer.

**Option A — an in-product message thread.** Buyer and seller exchange
messages inside the app; no PII ever leaves the platform.

**Option B (chosen) — consented contact exchange.** Each side optionally
supplies a contact; on ACCEPT, and only on ACCEPT, each is shown the *other's*.

Four reasons B won:

1. **It makes a promise we already shipped true.** `inquiry-email.ts` had been
   telling sellers their contact details were part of the flow since the
   feature launched. Option A would have required retracting that sentence;
   option B implements it. Given a choice between deleting a promise and
   keeping it, keeping it is the smaller lie to have told.

2. **The thread's headline advantage is already spent.** "No PII leaves the
   platform" is false today: `notifySellerOfInquiry` emails the buyer's
   free-text message off-platform to up to 25 seller admins before anyone has
   consented to anything. A thread would add a second, cleaner channel beside
   a leaky one — not close the leak. (What *did* close, in this PR, is the
   silence about it: `InquiryModal` now names the recipients before the buyer
   types.)

3. **A thread makes both parties keep returning to an app the buyer
   demonstrably does not revisit** — which is the defect being fixed, not a
   solution to it. Bulgarian grain trading happens by phone. A number lets two
   farms transact today; a thread makes them wait on each other's next login.

4. **A thread is a roadmap, not a feature**: new model, new endpoints, unread
   state, per-message notification, sanitisation, moderation, abuse reporting.
   The contact exchange is two nullable columns and one gate.

**What the anonymity model cost.** Nothing. A seller is anonymous in the feed
and *stays* anonymous on decline. `sellerContact` is per-LISTING, not
per-tenant, so a seller can route different offers to different people, and an
anonymous seller becomes reachable only once they choose to be — public name
blank, contact filled, is a supported and sensible combination.

## Design

```
seller                                   buyer
  │                                        │
  │ CreateOfferModal                       │ InquiryModal
  │  └─ sellerContact (private)            │  ├─ message  ──── emailed to ≤25
  │                                        │  │                seller admins
  │                                        │  └─ inquirerContact (private)
  ▼                                        ▼
ExchangeListing.sellerContact      ExchangeInquiry.inquirerContact
  │                                        │
  └──────────────┬─────────────────────────┘
                 │
      respondToInquiry(ACCEPTED)
                 │   status + contactSharedAt in ONE update
                 │   CHECK (contactSharedAt IS NULL OR status='ACCEPTED')
                 ▼
        toPublicInquiry ── THE reveal gate ── the only place this is decided
                 │
      shared? ───┴─── no ──▶ counterpartyContact: null  (for everyone)
        │
       yes
        ├── viewer is inquirer ──▶ listing.sellerContact
        ├── viewer is seller   ──▶ inquiry.inquirerContact
        └── anyone else        ──▶ null
```

Three properties the shape buys:

- **`contactSharedAt` IS the enforcement point**, not a flag beside one. It is
  written in the same update as the status, so there is no window where an
  inquiry is ACCEPTED-but-unshared; a CHECK constraint refuses the
  inconsistent pair; and the gate reads the stamp, never the status string. An
  endpoint that sets `status = 'ACCEPTED'` on its own reveals nothing.
- **The gate lives in ONE function**, so a future endpoint cannot forget it.
- **Each viewer gets the OTHER side's contact** — never their own echoed back,
  never both. A "both contacts" payload is then not one refactor away.

### Where the seller's half nearly broke

`listListingsBySeller` nests inquiries *under* the listing, so the inquiry rows
it returns carry no `listing` of their own — and the gate identifies the seller
side via `row.listing.sellerTenantId`. Left alone, an accepting seller would
have seen `counterpartyContact: null` forever: accept would have completed
half a deal. The my-listings route now hands each inquiry its parent listing
(`toPublicInquiry({ ...i, listing: l }, …, false)`). `includeListing: false`
keeps that row out of the wire shape, so the gate reads the private
`sellerContact` on it and the projection still never emits it.

### Failure surfacing on the seller's page

`fulfillListing` / `respond` were `try/finally` with no `catch`. A 400 from the
state machine became an unhandled rejection: the spinner stopped and the row
looked untouched. Worse from the confirm dialog — `Modal.Confirm` deliberately
keeps itself open when `onConfirm` throws *"so the caller can surface an
error"*, and no caller did, so the dialog just sat there. Both handlers now
catch, surface the server's message (which names the listing and the reason),
and resolve — so the dialog closes and the error is the thing that moved. The
undo-toast `onError` gained the same treatment: it rolled back silently before.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/exchange.prisma` | `sellerContact`, `inquirerContact`, `contactSharedAt` |
| `prisma/migrations/20260729090000_exchange_consented_contact/` | columns + the `contactSharedAt IS NULL OR status='ACCEPTED'` CHECK |
| `src/lib/exchange/public-listing.ts` | **the reveal gate** — `toPublicInquiry` |
| `src/app-layer/usecases/exchange.ts` | consent stamp on ACCEPT; accept refused off-ACTIVE; buyer notified on both outcomes; terminal listing states |
| `src/app-layer/repositories/exchange.ts` | `updateInquiryStatus(…, contactSharedAt)`, `declinePendingInquiries` |
| `src/app-layer/schemas/exchange.schemas.ts` | both contact fields, capped at 200 chars |
| `src/app/api/…/exchange/listings/route.ts` | passes `sellerContact` through to the usecase |
| `src/app/api/…/exchange/inquiries/route.ts` | passes `inquirerContact` through |
| `src/app/api/…/exchange/my-listings/route.ts` | hands each inquiry its parent listing so the gate can see the seller side |
| `…/exchange/CreateOfferModal.tsx` | private contact field + always-visible consent copy |
| `…/exchange/InquiryModal.tsx` | recipient disclosure before the message box; buyer contact field |
| `…/exchange/my-interests/MyInterestsClient.tsx` | buyer workspace: terms, seller, link back, contact reveal, row anchors |
| `…/exchange/my-listings/MyListingsClient.tsx` | error surfacing on every mutation; buyer contact on an accepted inquiry |
| `src/lib/email/inquiry-email.ts` | disclosure line corrected (accept, not "respond") |
| `messages/{en,bg}.json` | every string above, both locales |

## Decisions

- **`description`, not `hint`, for both consent statements.** `FormField`'s
  `hint` renders as an `InfoTooltip` — hover-only. A consent statement someone
  has to hover to read is not a disclosure. Both contact fields use the
  always-visible `description` slot.

- **Accept stays a one-click action, with inline disclosure instead of a
  confirm dialog.** Accepting is the consent moment, so it says what it shares
  *before* the click ("Accepting shares this listing's contact with the buyer,
  and theirs with you"). A modal there would be friction pointed the wrong
  way: the seller already opted in by typing a contact into the listing, and
  the destructive-action convention reserves confirmation for the *decline*
  path, which is where the irreversibility is.

- **The buyer's contact is NOT in the seller's inquiry email.** That email
  goes to up to 25 admins before anyone has accepted anything. The seller's
  contact *is* in the buyer's accept notification, because at that point the
  consent has completed and the notification lives in the buyer's own tenant.

- **`counterpartyContact: null` on an accepted inquiry is a real state, and
  says so.** A seller can accept without ever having filled in a contact.
  Rendering an empty box there reads as a loading failure, so both pages
  explain the gap instead.

- **Row anchors on My interests.** `notifyBuyerOfResponse` deep-links to
  `…/my-interests#listing-<id>`; the page had no such id, so the anchor landed
  at the top of an unsorted list. The anchor now resolves.

- **`fulfillDescription` was corrected, not kept.** It claimed existing
  inquiries "stay visible" — written when fulfilling left every PENDING
  inquiry pending forever. Fulfilling now declines them and notifies those
  buyers, so the confirm dialog says that.

- **Inquiry + listing statuses are translated.** They were rendered as raw
  enum strings (`ACCEPTED`, `WITHDRAWN`) — tolerable next to other English
  copy, absurd next to the Bulgarian contact panel this PR puts beside them.

- **What was deliberately NOT done.** No message thread (see the fork). No
  contact-format validation — a "contact" is a phone number, an email, a Viber
  handle or a sentence saying to call after six, and rejecting the shapes we
  did not anticipate would be worse than accepting a typo. No contact on the
  public listing detail Sheet, at any status: the Sheet is a cross-tenant
  projection and `ExchangePublicListing` must never carry `sellerContact`.
