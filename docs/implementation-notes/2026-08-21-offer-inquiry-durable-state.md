# 2026-08-21 — the offer inquiry remembers itself

**Issue:** #651

## Design

`AskForOfferModal` recorded "this operator has asked" in a component-local
`useState(false)` whose only consumer was `disabled={sent}`. It died on
unmount, so navigating away and back re-enabled the button.

### The issue's premise is wrong, and the real defect is worse

The issue says the operator "can re-send" — a second message to a real
counterparty. **At the data layer that cannot happen.** `PromotionLead`
carries `@@unique([promotionId, inquirerTenantId])`
(`prisma/schema/promotions.prisma:133`) and `createPromotionLead` converts the
P2002 into a `conflict(...)` (`promotions.ts:205-212`). Postgres refuses the
second write.

What actually happened is one layer up, and it is not better:

1. The operator returns to `/offers`. The button reads "Ask for offer" and is
   enabled, because the component has no memory and the page has no state.
2. They **retype the entire message** — a free-text description of what their
   farm is short of — and **re-tick the consent box**.
3. They submit, and get a **409 whose body is a hard-coded English sentence**,
   rendered raw in the alert box: *"You have already requested an offer for
   this promotion."* `ConflictError` is `expose: true`
   (`src/lib/errors/types.ts:80-85`), and the modal shows `err.message`
   directly. The product's default UI language is Bulgarian.

So the cost is wasted effort and an untranslated error, delivered to someone
who did the right thing. The fix is to stop asking.

### The durable half, and why it needs no new endpoint

`hasRequested` is now a field on `PromotionDto`, computed in
`listActivePromotions` inside the transaction that already reads the page:

```ts
const requestedIds = new Set(
    (await db.promotionLead.findMany({
        where: { promotionId: { in: rows.map((p) => p.id) },
                 inquirerTenantId: ctx.tenantId, deletedAt: null },
        select: { promotionId: true },
    })).map((l) => l.promotionId),
);
```

`@@unique([promotionId, inquirerTenantId])` **is** the index, so this is a
covered lookup over at most `limit` (≤100) keys. It is bounded by the page
above it, so it needs no `take:` of its own.

`/offers` is an async server component with exactly one consumer of
`listActivePromotions`, so this reaches the UI as a prop — no new route, no
client fetch, no SWR key, no rate-limit tier, no permission registration. The
shape follows `ExchangePublicListing.isOwn`: a viewer-relative boolean
computed in the projection, never at the call site.

`justSent` remains as the **optimistic** half and is deliberately not the
source of truth — it bridges the gap until the server component re-renders.
`router.refresh()` was considered and rejected: it would refetch the whole
page on rural LTE to establish something the optimistic flag already shows,
and a real navigation re-runs the server component anyway.

## Three defects found in the same file

**The consent checkbox had no label.** `t('consent', { company })` and
`t('privacyLink')` resolve to keys that existed in **neither** `en.json` nor
`bg.json`, so next-intl rendered the literal key path as the label of the
control that gates the whole submit — the control the usecase calls *"a
lawfulness gate, not validation"* (`promotions.ts:176-178`), backed by a
`NOT NULL consentedAt` column documented as *"the enforcement point, not a
flag"*. Introduced by #352, which added the `t()` calls and no catalogue
entries.

No i18n check caught it, and this is the interesting part: every one of them
compares **en ↔ bg**. A key absent from both is symmetric, so parity passes —
and the no-hardcoded-strings ratchet actively *rewards* the broken form, since
replacing a literal with `t('keyThatDoesNotExist')` lowers the baseline. Filed
as **#662**; deliberately not fixed here, because a correct checker needs
scope-aware resolution (a first-cut scanner produced ~38 false positives out
of ~40 reports).

**Consent survived a cancel.** The comment claimed it "starts false every time
— never remembered across opens." Nothing implemented that: it was not reset
on success, on Cancel, or on backdrop dismissal. Open → tick → Cancel →
re-open left the box ticked. Now every close path routes through
`closeAndReset`, including the backdrop and Escape, which arrive through
`setShowModal` rather than through the Cancel button.

**The confirmation was a control that disabled itself.** The modal closed with
no toast — and closing is also what Cancel does. There is now a success toast
naming the company and pointing at notifications, where the server already
writes a durable record.

## Files

| File | Role |
|---|---|
| `src/app-layer/usecases/promotions.ts` | `hasRequested` on `PromotionDto`, one indexed lookup in the existing transaction |
| `src/app/t/[tenantSlug]/(app)/offers/page.tsx` | passes it through |
| `src/app/t/[tenantSlug]/(app)/offers/AskForOfferModal.tsx` | server-read + optimistic state, explained sent-state, consent reset on every close, success toast |
| `messages/{en,bg}.json` | `consent`, `privacyLink` (were missing entirely), `sentToast`, `alreadySent` |
| `tests/rendered/ask-for-offer-modal.test.tsx` | 9 assertions, mutation-proven |

## Decisions

- **The spent control is a focusable `role="note"`, not a disabled button.**
  `disabled` removes an element from the tab order, which would put the
  explanation out of reach of exactly the users most likely to need it. A
  disabled control with no stated reason is the shape that sent the operator
  back into the modal in the first place.

- **`hasRequested` is optional with a `false` default.** The prop is additive
  and the single call site passes it, but defaulting keeps the component
  usable in isolation — including from the rendered test's own `mount(false)`
  control.

- **The 409 body is left alone.** Translating a server error message is a
  different change with a wider blast radius (`ConflictError.expose` is used
  across the app), and after this fix the operator should never reach it.
  It remains the backstop for a genuine race between two devices.

- **The sibling is NOT fixed here, and the reason is cost, not doubt.**
  `farm-risk/AskInsuranceModal.tsx:30` has the identical
  `const [sent, setSent] = useState(false)` with `disabled={sent}` (`:56`),
  and `InsuranceLead` carries the matching
  `@@unique([parcelId, inquirerTenantId])` — so it is the same bug with the
  same server-side refusal behind it. What differs is the read path, and it
  is the whole reason this one was cheap:

  | | offers | farm-risk |
  |---|---|---|
  | page | async **server** component | `FarmRiskClient`, a **client** component |
  | existing read | `listActivePromotions`, one consumer | **none — nothing in `src/app-layer` reads `InsuranceLead` at all** |
  | cost of `hasRequested` | one lookup in a transaction that already runs | a new endpoint or a prop threaded from a parent server component |

  Here `hasRequested` needed no new read path. There it needs one invented
  from nothing. Filed separately rather than bundled, because "same fix,
  much larger change" is how a small PR becomes a stalled one — and,
  per the lesson of #626 this week, an exclusion recorded only in a merged
  PR body is not tracked. It is **#664**.
