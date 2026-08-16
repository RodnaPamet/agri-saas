# Billing & entitlements

> **Audience.** Operators choosing how to deploy the platform, and
> developers adding new gated features. The reference implementation
> lives at [`src/lib/billing/entitlements.ts`](../src/lib/billing/entitlements.ts).

This document describes the **operating model** the codebase ships
with today. It is not a roadmap for future billing features.

---

## TL;DR

| Question | Answer |
|---|---|
| Is Stripe required to run the app? | No. |
| What happens with no Stripe configured? | Every tenant resolves to `ENTERPRISE`. All gated limits become unlimited. |
| What happens with Stripe configured? | Each tenant's effective plan is read from `BillingAccount.plan` and per-plan limits are enforced before mutations. |
| Where is the gate enforced? | Server-side, before the DB write. Not in the UI. |
| How does the platform decide which mode it is in? | One env var: `STRIPE_SECRET_KEY`. |

---

## The two modes

### `SAAS` mode

* Triggered when **`STRIPE_SECRET_KEY`** is set to a non-empty value.
* The deployment is treated as the hosted SaaS product.
* Each tenant's effective plan comes from the `BillingAccount` row
  written to by Stripe webhooks (`plan = FREE | TRIAL | PRO | ENTERPRISE`).
* A tenant **without** a `BillingAccount` row resolves to **`FREE`**
  — that is the safe default for a SaaS tenant who has not started a
  paid subscription.
* Per-plan limits (see below) are enforced at every gated mutation.

### `SELFHOSTED` mode

* Triggered when **`STRIPE_SECRET_KEY` is unset or empty**.
* The deployment is treated as on-prem / OSS.
* Every tenant resolves to **`ENTERPRISE`**, regardless of any
  `BillingAccount` row that may exist.
* Per-plan limits are **not enforced** — every gated resource is
  effectively unlimited.
* Self-hosted customers paid for the right to run the software; they
  did not buy a SaaS subscription, so the codebase declines to
  pretend otherwise.

The decision is **process-wide and read once at module load** in
[`entitlements.ts`](../src/lib/billing/entitlements.ts). There is no
runtime flip — restart the process to change modes.

```ts
// src/lib/billing/entitlements.ts (excerpt)
const BILLING_MODE: BillingMode = process.env.STRIPE_SECRET_KEY
    ? 'SAAS'
    : 'SELFHOSTED';
```

If you want the deterministic decision in code:

```ts
import { getBillingMode } from '@/lib/billing/entitlements';

if (getBillingMode() === 'SAAS') { /* … */ }
```

---

## Per-plan limits (SaaS mode)

The full limits table lives in `PLAN_LIMITS` in
[`entitlements.ts`](../src/lib/billing/entitlements.ts). Four
resources are gated:

| Plan | `user` | `location` | `exchange_listing` | `ai_tokens` |
|---|---:|---:|---:|---:|
| `FREE` | 3 | 5 | 5 | 50,000 |
| `TRIAL` | 25 | 50 | 50 | 1,000,000 |
| `PRO` | 25 | 50 | 50 | 5,000,000 |
| `ENTERPRISE` | unlimited | unlimited | unlimited | unlimited |

`null` in the table means unlimited.

A fifth resource, `practice`, was gated until the GRC teardown removed
the model. This document described it as `control` — its name from
before the Control→Practice rename — which is worth noting because the
staleness was invisible: `getLimit` is typed on `GatedResource`, and
prose is not.

Notes on the choices:

* **`TRIAL` inherits `PRO`.** A paying-customer-on-trial gets the
  full working surface, not an artificially constrained one — the
  alternative is a UX cliff at the moment they enter billing details,
  which is exactly the wrong time for one.
* **`FREE` is "kick the tyres".** A single operator with a handful of
  fields — enough to run one small holding through a season, far short
  of what a working farm needs, which is the upgrade trigger.
* **`ai_tokens` is a windowed SUM, not a row count.** It caps total AI
  tokens consumed per calendar month (UTC) and resets; the other three
  are counts of live rows.
* **Status (CANCELED, PAST_DUE, …) is intentionally NOT factored
  in here.** The Stripe webhook handler is the source of truth for
  downgrade timing — it writes `plan` directly when a subscription
  ends. Adding a second branch in `getEffectivePlan` would race with
  the webhook and produce confusing user-facing failures.

---

## Where the gate runs

Gating happens **server-side at the mutation boundary**, immediately
after the per-resource RBAC assertion:

```ts
// src/app-layer/usecases/location.ts
export async function createLocation(ctx, data) {
    assertCanWrite(ctx);                              // RBAC
    await assertWithinLimit(ctx, 'location', tx);     // GAP-18 plan gate
    // … create the location …
}
```

Pass the transaction (`tx`) where the create runs in one, so the
check-then-act window is a single statement sequence rather than two
round trips apart.

The gate runs **before any write** so the DB never observes a row
that violated the plan. Read paths and UI rendering are NOT
considered the enforcement boundary — anything visible to the user
must be considered "advisory" until the server-side gate has run.

### Failure shape

When the gate trips, it throws `forbidden(...)` from
`@/lib/errors/types`. The HTTP wrapper surfaces this as **`403`**
with a body that includes:

```
plan_limit_exceeded: FREE plan allows 5 location(s); tenant currently has 5. Upgrade to add more.
```

The string contains the four pieces a client / billing UI needs to
render an upgrade CTA:

| Token | Meaning |
|---|---|
| `plan_limit_exceeded` | Stable error code, machine-grep-friendly |
| `FREE` | The plan that is currently in effect |
| `5 location(s)` | The limit + resource (singular/plural literal) |
| `tenant currently has 5` | The current count for that resource |

---

## Adding a new gated mutation (developer guide)

The entitlement layer is designed to make new gates a one-line
change at the call site plus a one-line change in the limits table.

**1.** Add the resource to the `GatedResource` union and the
`PLAN_LIMITS` table in
[`entitlements.ts`](../src/lib/billing/entitlements.ts):

```ts
export type GatedResource =
    | 'user'
    | 'location'
    | 'ai_tokens'
    | 'exchange_listing'
    | 'parcel';                                     // ← add here

const PLAN_LIMITS: Record<Plan, Record<GatedResource, number | null>> = {
    FREE: { user: 3, location: 5, ai_tokens: 50_000, exchange_listing: 5, parcel: 10 },       // ← add here
    TRIAL: { user: 25, location: 50, ai_tokens: 1_000_000, exchange_listing: 50, parcel: 100 },
    PRO: { user: 25, location: 50, ai_tokens: 5_000_000, exchange_listing: 50, parcel: 100 },
    ENTERPRISE: { user: null, location: null, ai_tokens: null, exchange_listing: null, parcel: null },
};
```

**2.** Teach `getCurrentCount` how to count the new resource. The
`switch` is exhaustive — TypeScript will surface every site that
needs updating:

```ts
async function getCurrentCount(ctx, resource) {
    return runInTenantContext(ctx, async (db) => {
        switch (resource) {
            case 'location': return db.location.count(/* … */);
            case 'parcel':   return db.parcel.count(/* … */);   // ← add
            // … the other arms …
        }
        const _exhaustive: never = resource;
        return _exhaustive;
    });
}
```

**3.** Call the gate at the create-site, AFTER the RBAC assertion
and BEFORE any DB write:

```ts
export async function createRisk(ctx, data) {
    assertCanCreateRisk(ctx);
    await assertWithinLimit(ctx, 'risk');           // ← add
    // … create the risk …
}
```

That's the entire surface. The gate inherits SaaS-vs-self-hosted
behaviour automatically — self-hosted is unlimited because
`getEffectivePlan` returns `ENTERPRISE` short-circuit, which then
returns `null` from `getLimit`, which short-circuits the count
query.

### What NOT to do

* **Do not gate in the UI.** The UI is welcome to render a CTA when
  the gate would trip (e.g. "4 / 5 fields used — upgrade?"), but
  the *enforcement* must live behind the API.
* **Do not introduce a second mode-detection mechanism.**
  Everything routes through `getBillingMode()` so the decision is
  visible in one place. If you find yourself reading
  `process.env.STRIPE_SECRET_KEY` somewhere else, prefer importing
  from this module.
* **Do not branch on `BillingStatus`** to decide if a limit
  applies. Status is the webhook handler's concern — the
  entitlement layer reads `plan` only.
* **Do not duplicate the limits table.** Tests and call sites read
  `PLAN_LIMITS` through `getLimit(plan, resource)`. Anywhere else
  re-encoding "FREE allows 5 locations" is a place that will silently
  drift. This document drifted exactly that way: it described the
  gated resource as `control` for months after the Control→Practice
  rename, and then after the model was deleted entirely.

---

## Operator runbook

### "How do I run this self-hosted with no enforcement?"

Don't set `STRIPE_SECRET_KEY` in your deployment env. The platform
detects the absence at boot and resolves every tenant to
`ENTERPRISE`. No additional configuration required.

### "How do I verify the platform is in self-hosted mode?"

Check the running process's env: `STRIPE_SECRET_KEY` should be
**unset or empty**. If it is, every tenant resolves to `ENTERPRISE`
and `assertWithinLimit` returns immediately without consulting
the DB. There is no separate "self-hosted feature flag".

### "We're self-hosted but want to enforce limits internally"

Out of scope for this iteration. The intentional model is binary:
SaaS *or* self-hosted-unlimited. If you need fine-grained quotas
in a self-hosted deployment, file an issue — that is a deliberate
new mode (e.g. "self-hosted-with-quotas") and would need its own
config surface, not a flag flip on the existing two.

### "A tenant has been downgraded but is still creating records"

Check `BillingAccount.plan` for the tenant — that is the source of
truth. The webhook handler is responsible for moving the row from
`PRO` back to `FREE` when a subscription cancels. If the row is
still `PRO`, the webhook didn't fire or didn't apply (look at
`BillingEvent` for the trail).

### "We just added a new gated resource and limits aren't applying"

Three things to verify in order:
1. The resource is listed in `GatedResource` AND `PLAN_LIMITS`.
2. `getCurrentCount` has a `switch` arm that returns the actual
   count for the resource (not `0`, not `undefined`).
3. The create-site calls `await assertWithinLimit(ctx, '<resource>')`
   AFTER the RBAC `assert*` and BEFORE the DB write.

If all three are correct, the gate is firing — confirm with a
unit test that mocks `BillingAccount.findUnique` to return your
target plan and the resource count to the limit value.

---

## See also

* [`src/lib/billing/entitlements.ts`](../src/lib/billing/entitlements.ts) — the implementation.
* [`src/lib/stripe.ts`](../src/lib/stripe.ts) — Stripe wrapper used in SaaS mode for checkout / portal flows.
* [`tests/unit/billing/entitlements.test.ts`](../tests/unit/billing/entitlements.test.ts) — exhaustive test for the SaaS / self-hosted decision and the `assertWithinLimit` enforcement path.
