# 2026-08-20 — Three signed webhooks had never been delivered

**Commit:** `<pending> fix(webhooks): let signed webhooks reach their handlers`

## What was wrong

```
POST /api/stripe/webhook            → 401 {"error":"Unauthorized"}
POST /api/storage/av-webhook        → 401 {"error":"Unauthorized"}
POST /api/integrations/webhooks/:p  → 401 {"error":"Unauthorized"}
```

That body is `unauthorizedJson()` from the middleware, not any handler's own
refusal. Verified by driving the real middleware.

The cause is the sixth instance of one shape: the route is not in
`PUBLIC_PATH_PREFIXES`, the sender (Stripe, the AV scanner, a third-party
service) cannot carry a NextAuth session cookie, `getToken()` returns null, and
the request is refused before the handler that would have checked its
signature. `token.error`, `iflk_`, SCIM, and these three.

Stripe's own docblock reads *"Public (no auth), but verifies signature"* — the
design was right; the Edge simply never let it through.

## Severity was checked, not assumed

On the `agrent` VM `STRIPE_SECRET_KEY` is unset and `AV_SCAN_MODE=disabled`, so
both are dormant and **nothing is broken in production today**. That is exactly
what let this survive: it fails silently the day someone enables either. Set
`STRIPE_SECRET_KEY` and subscription state never updates from Stripe —
payments succeed, plans never change, nothing errors anywhere.

## Why opening the Edge is safe here

Every handler verifies its own credential **and fails closed without one**:

| route | verifies | with no secret |
|---|---|---|
| stripe | `constructWebhookEvent` | throws `STRIPE_WEBHOOK_SECRET is not configured` |
| av-webhook | HMAC-SHA256 + `timingSafeEqual` | **500** in production; explicit dev-only bypass |
| integrations | per-connection secret | `auth_failed` → 401 |

That was checked before the carve-out was written, not after.

## The guard is general

A fourth bespoke guard was the obvious move and the wrong one. Instead
`tests/guards/public-routes-self-authenticate.test.ts` enforces both directions
of one rule, derived from the filesystem:

- **A** — a route that reads a credential header and verifies it must be
  reachable.
- **B** — a route behind a public prefix must verify something.

Either alone is worse than none: A without B converts dead endpoints into
anonymous ones, and B without A leaves them dead.

## Files

| file | role |
|---|---|
| `src/lib/auth/guard.ts` | the three prefixes, with the reasoning |
| `src/lib/rate-limit/scimRateLimit.ts` | the tier now covers the webhooks |
| `src/middleware.ts` | comment corrected — the tier is no longer SCIM-only |
| `tests/guards/public-routes-self-authenticate.test.ts` | NEW — both directions |
| `tests/unit/webhook-edge-reachability.test.ts` | NEW — drives the real middleware |

## Decisions

- **The detector was widened, not the routes exempted.** On its first run the
  guard flagged `/api/staging/seed` and the integrations webhook. Both were
  legitimate — an `x-seed-token` comparison against `STAGING_SEED_TOKEN`, and
  `processIncomingWebhook` returning `auth_failed`; I had guessed the wrong
  function name. Exempting them would have hidden the next genuinely-anonymous
  route added under either prefix, so the patterns were fixed and a note left
  in the file saying so.

- **They share the SCIM rate tier.** Same traffic class — machine-to-machine,
  signed, bursty on retry — and a fourth budget would be a number nobody could
  justify differently. The rationale is SCIM's: an anonymous caller reaching a
  signature comparison is unbounded database and log load, because every
  handler logs a warn on a bad signature.

- **`/api/integrations/webhooks/` is prefixed with the trailing segment**, not
  `/api/integrations/`. The behavioural test asserts `/api/integrations/connections`
  is still gated — a prefix that leaks a sibling is the same class of bug as no
  gate at all.

- **Both halves of the test story, deliberately.** The guard is a claim about a
  list; the unit test is a claim about behaviour. SCIM proved those are
  different facts. The unit test is mutation-proven — removing the carve-outs
  fails three assertions — and carries a negative control so a middleware that
  stopped refusing anything could not pass.
