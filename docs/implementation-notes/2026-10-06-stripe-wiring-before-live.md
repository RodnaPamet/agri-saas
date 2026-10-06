# Stripe: three fixes before money moves

*2026-10-06 · branch `fix/stripe-wiring-before-live`*

Billing is dormant — `STRIPE_SECRET_KEY` is absent from the VM (checked by
presence, never value), so `getStripe()` throws on first call and none of this
runs in production. That is precisely why these were worth fixing now: each one
is free today and expensive the week money starts moving.

## 1. Cancelling never downgraded the plan

The real defect, and it was not the one I set out to fix.

`getEffectivePlan()` reads `BillingAccount.plan`. Its docblock is explicit that
status is *not* an entitlement input:

> Status (CANCELED, PAST_DUE, …) is INTENTIONALLY NOT YET ENFORCED here — a
> CANCELED PRO tenant still resolves to PRO until the subscription end date.
> **The webhook handler is responsible for downgrading the row to FREE when the
> period ends.**

That handler is `handleWebhookEvent`, and it never did. Its
`customer.subscription.deleted` branch set `status: 'CANCELED'` and nulled the
subscription id, and left `plan` untouched. Measured: `plan: 'FREE'` appears in
exactly one place in the module — account creation — and nothing outside
`lib/stripe.ts` writes it. There is no billing job or sweep either.

So once a tenant reached PRO, no code path returned them to FREE. **Cancel the
subscription, keep the paid entitlements forever.**

The branch now writes `plan: 'FREE'` (and clears `currentPeriodEnd`). The timing
is right by construction rather than by a scheduler: with
`cancel_at_period_end`, Stripe sends `customer.subscription.updated` at the
moment of cancellation and `customer.subscription.deleted` only when the period
actually ends — exactly the boundary the entitlements docblock describes.

### How it was found, which is the transferable part

I had flagged a different thing: `mapStripeStatus()` ends `default: return
'ACTIVE'`, which I called a fail-open on billing. **That was wrong**, and the
codebase said so in the docblock quoted above — status grants nothing; it is
displayed on the admin page and nothing else.

Verifying that premise is what surfaced the real defect one level over. The
lesson is the cheap one: grep for the comment that *explains* an absence before
calling the absence a defect. The explanation here named the handler that was
supposed to do the work, which is what made its silence findable.

## 2. The plan was guessed, and guessed generously

`mapStripePlan()` returned `'PRO'` for anything it did not recognise, including
a subscription with no metadata at all. Since `getEffectivePlan()` reads this
column, that silently granted PRO to any subscription created outside our own
checkout — the Stripe dashboard, a migration, the API. Guessing in the
customer's favour is the expensive direction.

Replaced by `resolvePlan()`, which tries two sources in order of
trustworthiness — `metadata.plan` (stamped by `createCheckoutSession`, so our
own flow always hits it), then the subscription's **price id** against the two
configured prices — and returns `null` when it cannot tell. The callers then
leave the stored plan alone and log a warning, rather than inventing one.

## 3. The API version was unpinned

`new Stripe(key)` with no `apiVersion` adopts whatever the installed SDK
defaults to, so an SDK major silently changes which Stripe API production talks
to. That is a behavioural change to payments which appears in a diff as a
version number and which no typecheck or test can see. stripe@23 moved this pin
from the v22 default; #1309 landed it while billing was dormant, which is the
only reason it cost nothing.

Now pinned to `2026-09-30.endive`, hard-coded rather than read from the SDK's
own `ApiVersion` export — taking the export would keep tracking the default and
defeat the purpose. The SDK types `apiVersion` as `typeof ApiVersion`, a single
literal, so the constant **stops compiling** when a future SDK ships a different
version. The upgrade becomes a compile error and a deliberate decision.

## What is still NOT done

- No live keys. Steps for the operator: create the two recurring prices, the
  secret key and a webhook endpoint subscribed to the six events this handler
  switches on, then put four `STRIPE_*` values in `/opt/agrent/.env` and run
  `deploy/apply.sh`. The VM compose uses `env_file: .env` and does **not** pin
  `STRIPE_*` in its `environment:` block, so the env file is sufficient — worth
  stating because `environment:` silently overrides `env_file:` and that has
  cost time before.
- `PAST_DUE` still grants full entitlements. That is the documented intent, not
  an oversight, but it is a policy worth a decision before launch rather than
  after the first failed payment.
- `mapStripeStatus()` still defaults an unrecognised Stripe status to `ACTIVE`.
  Harmless while status is display-only; it would need revisiting the day status
  becomes an entitlement input.
