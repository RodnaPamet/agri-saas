# Insurance premium calculator (#1118–#1122)

A farmer taps one button on a parcel card in Farm risk and gets a price. Five
PRs: the engine, the server-side quote, the wizard, the crop-wide chip, and this
hardening pass.

## The path a quote takes

```
"Request insurance quote"  (per-parcel button, Farm risk)
  → QuoteWizard            3 steps, in the same drawer; no page, no nav entry
  → POST /t/{slug}/insurance/leads   { parcelId, locationId, risk, quote, message? }
  → server RECOMPUTES the premium from the four quote inputs
  → snapshot written to InsuranceLead.quoteJson  (never recomputed on read)
  → operator email, rendered from that snapshot in the recipient's locale
```

The client may **preview** a price. It never states one: the body carries
`productKey`, `areaDca`, `sumInsuredCents` and `instalments`, and `.strip()`
drops anything else. What the operator sees is the server's own arithmetic.

## Files

| Area | Files |
|---|---|
| Engine | `src/lib/insurance/{premium,parse,products,format,crop-area}.ts` |
| Schema | `src/app-layer/schemas/insurance.schemas.ts` |
| Usecase | `src/app-layer/usecases/insurance.ts` (`buildQuoteSnapshot`, `createInsuranceLead`) |
| Route | `src/app/api/t/[tenantSlug]/insurance/leads/route.ts` |
| Email | `src/app-layer/notifications/templates.ts` (`buildInsuranceLeadEmail`) |
| UI | `src/app/t/[tenantSlug]/(app)/farm-risk/AskInsuranceModal.tsx` + `insurance/` |
| Primitive | `src/components/ui/step-wizard.tsx` |
| Migration | `prisma/migrations/20260926100000_insurance_lead_quote` |

## Decisions, and why

**A flat 10 % tariff, in basis points.** `tariffBp: 1000` on every product. One
rate is what the licensed partner confirmed for an indicative figure; basis
points mean the rate is an integer like the money, so nothing multiplies a
float.

**Decares only.** Areas are stored in hectares and converted on prefill
(`haToDca`); hectares never appear in the calculator. Farmers here quote land in
дка, and showing both units invites the wrong one being typed.

**Integer cents everywhere, round-half-up.**
`floor((sumInsuredCents * tariffBp + 5_000) / 10_000)` — adding half the divisor
before flooring is round-half-away-from-zero, and both operands are integers.
`MAX_SUM_INSURED_CENTS` is 1e11 so `cents × bp` stays under
`Number.MAX_SAFE_INTEGER` (1e11 × 1e4 = 1e15 < 9.007e15).

**Leftover cents go on the FIRST instalment.** €10,000 over three is
€3,333.34 + €3,333.33 + €3,333.33. The parts must reconstruct the total exactly
or the farmer pays something other than the quote; putting the remainder first
means the largest payment is the one they have already decided to make.

**No instalment surcharge.** Paying in four costs the same as paying once. An
indicative figure that changes with the payment plan is two quotes wearing one
label.

**"Indicative premium", and a disclaimer.** A priced cover reads as an offer.
The insurer confirms the final one, and the wording says so on step 3.

**No outbox queueing.** The calculator works offline; sending does not. A queued
lead would email the operator hours later with figures the farmer may have since
corrected. Send is disabled offline with an inline notice.

**`Idempotency-Key` → `clientMutationId`.** Same shape as `ExchangeMessage`, not
a second pattern. Minted at the first Send and held while the four quote inputs
are unchanged, so a retry replays one lead; any edit mints a NEW key, because
reusing it would return the original lead and the farmer would believe the
corrected figures went out. Postgres treats NULLs as distinct, so a client that
omits the header is unaffected.

Two placements are load-bearing, and both were wrong first:

- The replay short-circuits **outside** the transaction, because notifications
  dispatch after it — returning early from inside re-sent the operator email.
- The race backstop is **also** outside: a unique violation aborts the
  transaction, so a re-read inside it can never run.

**Its own rate tier.** `INSURANCE_LEAD_LIMIT`, 20 per hour. The endpoint
borrowed `EXCHANGE_INQUIRY_LIMIT` (10 per *minute*), which permits 600 operator
emails an hour — the wrong window shape once repeat asks became legitimate.

**No `/insurance` page, and no sidebar entry.** The question "what would this
cost?" belongs on the parcel the farmer is already looking at. A page would need
its own navigation, its own parcel picker, and an entry in
`isOperatorAllowedPath` — and the MECHANISATOR is deliberately locked out of
Farm risk.

## What the hardening pass found

Each of these was a real defect, not a hypothetical:

| Found | Where it lived |
|---|---|
| `ToggleGroup` had no coarse-pointer floor — ~30px targets against the 44px minimum, on three controls of this very flow | `src/components/ui/toggle-group.tsx`; now pinned by `tests/guards/button-touch-target-floor.test.ts` |
| `translateFor` has **no ICU support**, so a plural in email copy renders as its own source text | fixed in #1121; pinned by `tests/guards/no-icu-plural-in-email-copy.test.ts` |
| `Modal.Header`'s `title` collapsed to `string & ReactNode`, so a header title could never be an element | `src/components/ui/modal.tsx` |
| `isDirty` watched only the sum and the note, so an edited AREA was discarded without asking | `useInsuranceQuote` |
| `CreateInsuranceLeadInput` was a hand-written duplicate of the schema and had already fallen behind it | now derived from the schema |
| A hardcoded English `dca` in an email that goes out in Bulgarian | `templates.ts` |
| Three stale claims that a dropped `@@unique` still made a second request impossible | modal docblock, `FarmRiskClient`, and the Prisma schema |

## Where each property is pinned

| Property | Test |
|---|---|
| The engine's arithmetic, caps and rounding | `tests/unit/insurance/premium.test.ts` |
| Parser asymmetry (money thousands vs area decimal) | `tests/unit/insurance/parse.test.ts` |
| Browser and server reach the same figure | `tests/unit/insurance/client-server-agreement.test.ts` |
| Crop aggregation, with every exclusion rule | `tests/unit/insurance/crop-area.test.ts` |
| Malformed bodies are 400, never 500; key bounds; operator lockdown | `tests/unit/insurance/lead-route-hardening.test.ts` |
| Client price ignored; `<script>` sanitised; mail escaped | `tests/unit/insurance/lead-injection-hardening.test.ts` |
| Idempotent replay, the race, and cross-tenant isolation | `tests/integration/insurance-lead-quote.test.ts` |
| Area scope stored and rendered in both languages | `tests/unit/insurance/lead-area-scope.test.ts` |
| The five StepWizard fixes, one test each | `tests/rendered/step-wizard.test.tsx` |
| The full flow, phone and desktop, en | `tests/rendered/insurance-quote-wizard.test.tsx` |
| The full flow in Bulgarian | `tests/rendered/insurance-quote-wizard-bg.test.tsx` |
| axe on all three steps, keyboard walk, live region | `tests/rendered/insurance-quote-a11y.test.tsx` |
| The real POST, and "Request sent" surviving a reload | `tests/e2e/insurance-quote.spec.ts` (`@mobile`) |

## Two local-verification notes

**`--forceExit` is needed for the unit project.** `globalSetup` leaves a
connection open, so jest finishes the tests and then hangs; a single file took 17
minutes before the run was killed, having actually completed in 0.85s. A hang and
a slow suite look identical from outside.

**The E2E runs on the phone projects, twice.** The spec is tagged `@mobile`, so
`grepInvert: /@mobile/` keeps it off the desktop project — where `.tap()` would
fail for want of `hasTouch` — while `mobile-android` and `mobile-iphone` both
select it. `npx playwright test tests/e2e/insurance-quote.spec.ts` therefore runs
2 tests, not 0; confirmed with `--list`. Worth confirming that way rather than
reasoning from the config, since a tag that matched nothing would look identical
to a pass.
