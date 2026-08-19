# 2026-08-19 — API-key creation closed; a context-swap path closed with it

**Commit:** `<pending> fix(api-keys): stop minting credentials that cannot authenticate`

## What was wrong

A tenant API key (`iflk_…`) has never authenticated a request, on any
deployment, since the feature shipped.

`src/middleware.ts` calls `getToken({ req, secret })`. next-auth v4 *does* read
an `Authorization: Bearer` header — and then runs the value through its JWE
`decode()`. An `iflk_` token is not a JWE, decode throws, `getToken` returns
`null`, and the request is refused with a generic 401 before any handler, and
therefore before `verifyApiKey`, runs. Verified over real HTTP:

```
$ curl -H 'Authorization: Bearer iflk_…' /api/t/<slug>/journal
401 {"error":"Unauthorized"}
```

Meanwhile the admin UI minted keys, displayed each once, and told the operator
"Copy this key now — it will never be shown again!". The docs described the
flow as working.

## The second defect, found on the way

`tryApiKeyAuth` returns a `RequestContext` that **replaces** the session's:

- `tenantId` / `tenantSlug` come from the KEY (`apiKey.tenantId`,
  `apiKey.tenant.slug`) — with **no comparison** to the route's `tenantSlug`;
- `role` is re-derived from the key's SCOPES (`scopes.includes('*')` →
  `ADMIN`).

and it ran **before** `getSessionOrThrow()` in both `getTenantCtx` and
`getLegacyCtx`.

Not reachable from a machine client — the Edge refuses the bearer first — but
reachable from a **browser** carrying both a session cookie (which satisfies
the Edge on its own) and an API-key header:

- **Tenant confusion.** A request to tenant A's URL binds RLS via
  `runInTenantContext` to the key's tenant B, and `logEvent` attributes the
  write to B's key creator.
- **Role elevation.** A user demoted to READER who kept an old `*` key gets an
  ADMIN-permission context on every non-admin tenant route. (Admin API paths
  are separately floored at the Edge by `token.role`.)

`getLegacyCtx` is the worse half: it serves routes that are **not** under
`/api/t/` — evidence, audit-log, notifications, sso, admin diagnostics — which
never pass through the Edge tenant gate at all.

## Design

One compile-time switch, `API_KEY_AUTH_ENABLED`, in a dependency-free module
(so the `'use client'` admin page can import it). Three consumers: the create
route (410), the admin page (no create affordance + a notice), and the docs.

**Nothing is deleted.** `createApiKey`, `verifyApiKey`, the scope machinery,
`TenantApiKey` and the list/revoke UI stay, so a named M2M customer is a flag
flip plus the Edge work — and revoking already-issued keys still works today,
which is why the page stays reachable rather than being hidden.

The context path is fixed **structurally**, not merely switched off:
`tryApiKeyAuth` now takes a **required** `expectedTenantSlug` and compares it,
so a revival cannot reintroduce the confusion by forgetting an argument.
`getLegacyCtx` does not call it at all — it has no slug to compare against.

## Files

| file | role |
|---|---|
| `src/lib/auth/api-key-availability.ts` | NEW — the switch, and what re-enabling requires |
| `src/app/api/t/[tenantSlug]/admin/api-keys/route.ts` | 410 Gone with a diagnostic body |
| `src/app-layer/context.ts` | gate + required tenant comparison; legacy path removed |
| `src/app/t/[tenantSlug]/(app)/admin/api-keys/page.tsx` | create affordance hidden; notice added |
| `docs/enterprise-identity-custom-roles-api-keys.md` | status banner; the request-path section marked unreachable |
| `tests/guards/api-key-auth-disabled.test.ts` | NEW — the revival ratchet |
| `tests/unit/api-key-auth-disabled.test.ts` | NEW — executing proof of the disabled path |
| `tests/guardrails/enterprise-identity-epic.test.ts` | two assertions INVERTED (see below) |

## Decisions

- **410, not 404, and not a bare error.** The endpoint existed; the body says
  why it no longer serves. The entire failure being fixed is a credential that
  fails indistinguishably from a wrong one — an opaque refusal repeats it.

- **The page stays, the button goes.** Removing the admin pill would hide the
  only surface that lists and REVOKES keys already issued, which is the one
  operation that still works and the one an operator most needs after learning
  the keys are useless.

- **The i18n description had to change too.** `admin.apiKeys.description`
  promised "machine-to-machine API keys for programmatic access" and renders
  directly ABOVE the new notice. Shipping both would have put a live promise
  one line above a banner saying it does not work. It now describes what the
  page actually does: review and revoke.

- **Two guardrail assertions were INVERTED, not deleted.**
  `enterprise-identity-epic.test.ts` required that BOTH context builders
  attempt key auth before the session. That is now the wrong contract. Worth
  recording: the old `getLegacyCtx` assertion was
  `expect(legacyCtx).toContain('tryApiKeyAuth')` — a raw source grep, so the
  explanatory COMMENT left in place of the removed call satisfied it. It would
  have stayed green while asserting a call that no longer existed. The
  replacement asserts on the function body only and is mutation-proven.

- **The revival ratchet is the point of the PR.** Flipping the flag to `true`
  looks like a one-line change and is not: with no Edge carve-out, every
  request still 401s, so the flag would claim a working feature and deliver the
  identical dead one — which is how this happened the first time. CI fails,
  naming what is missing: an Edge carve-out (with a fail-closed guard, as SCIM
  now has), `enforceApiKeyScope` wired up (**zero callers** today — scopes only
  feed a coarse role derivation), a rate tier for the now-anonymous surface,
  and an HTTP-level test through the middleware.

- **The tenant comparison has no executing coverage, and that is stated.**
  While the switch is off, `tryApiKeyAuth` returns before reaching it, so the
  comparison is dead code. The guard asserts its presence; the executing test
  covers the disabled path. Whoever revives the feature owes it a real test —
  which is exactly what the ratchet's failure message demands.
