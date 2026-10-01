# 2026-10-01 — the authenticated rate-limit key, actually keyed by user

**Commit:** `<pending> fix(security): resolve the rate-limit userId at the choke point`

## Design

`buildRateLimitKey` has carried this since Epic A.2:

> CGNAT rationale — DO NOT "simplify" the authenticated key to IP-only. This
> is a mobile-first product: most users arrive over carrier networks, where
> carrier-grade NAT puts *thousands* of unrelated subscribers behind ONE
> public IPv4. […] every authenticated preset MUST keep the userId.

Measured against that paragraph:

```
route files wrapped in withApiErrorHandling   346
of those, passing a getUserId resolver          3
=> keyed <scope>:ip:<ip>:anon                 343
```

So the shape the docblock forbids was the shape 99% of the API used. One
farmer's busy morning, or one abuser, spent the whole 60/min budget for every
other subscriber on the same carrier egress — and the three routes that did
pass a resolver pass it for an unrelated reason (their budget is bounded by a
TARGET user, not the caller).

**Nothing was wrong with the mechanism.** `getUserId` worked. It was OPT-IN,
and an invariant that holds only when 346 route authors each remember it is
not an invariant — it is a convention with a 1% adoption rate.

So the resolution moved to the choke point every wrapped route already passes
through. `resolveRateLimitScope` calls `resolveRequestUserId` when no resolver
is supplied, and `getUserId` became an override.

## Files

| File | Role |
|---|---|
| `src/lib/security/rate-limit-identity.ts` | **new** — `resolveRequestUserId`: `getToken` → `token.sub`, fail-soft to null |
| `src/lib/errors/api.ts` | `resolveRateLimitScope` resolves the bucket first, then the userId by default; `getUserId`'s docblock now describes an override |
| `tests/unit/rate-limit-keyed-by-user.test.ts` | **new** — drives the real wrapper, asserts the key the store is handed |
| `CLAUDE.md` | the "Keyed `(IP, userId)`" claim, which was false for 343 routes |

## Decisions

- **A token decode per mutation is affordable; a forged header is not.** The
  obvious optimisation is to have middleware — which already decodes the token
  for the auth gate — pass the id down in a request header. Rejected: a client
  setting that header to someone else's id poisons their bucket, and setting a
  fresh value per request escapes the limit entirely. It is only safe if
  middleware unconditionally overwrites the inbound value on *every* matched
  path, a guarantee spread across the whole matcher instead of held in one
  place. Decoding the credential we were actually sent cannot be spoofed. The
  cost is one symmetric JWE decrypt — no database, no network — on mutations
  only, which are the minority of traffic and already bound for a DB write.
- **Fail SOFT to `anon`.** Any failure returns null, which is the
  pre-existing behaviour and a TIGHTER bucket, not a looser one. A limiter
  that threw would turn an unreadable cookie into a 500 on a write path; one
  that failed open would be worse.
- **`token.sub`, matching the read tier.** `middleware.ts` keys
  `apiReadRateLimit` on `token.sub`, so both tiers now bucket a given user
  identically rather than disagreeing about who they are.
- **Bearer tokens resolve too.** `getToken` accepts an `Authorization: Bearer`
  header, so the native client is keyed per user instead of every phone on a
  carrier sharing one `anon` bucket.
- **`getBucket` is resolved FIRST.** It replaces the ip+userId portion
  entirely (#1161), so resolving an identity for a bucketed route is a decode
  thrown away. Ordering it first also means the exchange-message path pays
  nothing.
- **The test drives the wrapper, not the key builder.** The sibling
  `mutation-rate-limit.test.ts` calls `buildRateLimitKey` directly and proves
  the FORMAT — which is exactly why it never noticed that 343 routes handed it
  a null. This one goes through `withApiErrorHandling` and asserts on the key
  `enforceRateLimit` passes to the store.
- **The bypass needs `RATE_LIMIT_ENABLED='1'`, not merely "not 0".**
  `isRateLimitBypassed` has a fourth clause that bypasses whenever
  `NODE_ENV === 'test'`. Clearing the three obvious flags leaves the limiter
  off, every key unbuilt, and the file passing while testing nothing — which is
  what the first control in that file catches, and what the first draft did.
