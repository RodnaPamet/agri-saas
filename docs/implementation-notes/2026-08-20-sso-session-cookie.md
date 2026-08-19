# 2026-08-20 — SSO had never signed anyone in

**Commit:** `<pending> fix(sso): mint a session cookie NextAuth v4 can actually read`

## What was wrong

Both SSO callbacks hand-rolled the session cookie:

```ts
const sessionToken = jwt.sign({ userId, email, tenantId, role, sub }, authSecret, { expiresIn: '7d' });
const cookieName = env.NODE_ENV === 'production'
    ? '__Secure-authjs.session-token' : 'authjs.session-token';
cookieStore.set(cookieName, sessionToken, …);
```

**Four defects, and the first three are each independently fatal.**

1. **`jwt.sign` produces a JWS.** NextAuth v4 decodes a **JWE** via
   `jose.jwtDecrypt`. A JWS does not decrypt.
2. **`authjs.session-token` is the NextAuth *v5* name.** This app is v4
   (`4.24.15`), which reads `next-auth.session-token` — the same names
   `src/middleware.ts` clears on revocation.
3. **The claim set was too thin.** The Edge tenant gate authorises purely by
   scanning `token.memberships[].slug` (`checkTenantAccess`). A token with
   `tenantId`/`role` but no `memberships` decodes fine and then yields
   `no_tenant_access`.
4. **The secure prefix came from `NODE_ENV`.** v4 derives it from
   `NEXTAUTH_URL.startsWith('https://')`, so a production deploy behind plain
   http (or https staging) would write one name and read the other.

So the assertion validated, the identity linked, the user was redirected to
`/t/<slug>/dashboard`, and the middleware bounced them to `/login`. A loop,
with no error anywhere. **Nobody has ever completed an SSO login.**

Proven, with a positive control so a broken harness could not agree:

```
encode()-minted token, v4 cookie name     → READABLE
sso-minted JWS, "authjs.session-token"    → null
sso-minted JWS, "next-auth.session-token" → null
```

## Why defect 3 is the interesting one

A "fix the cookie name" patch — the obvious reading of the bug — would have
made the token decode and left SSO just as broken, now failing one gate later
and looking like a permissions problem. That is why the claim set was mapped
before any code was written rather than after the first fix failed.

## Design

`src/lib/auth/sso-session.ts` owns minting for both providers.

**Claims come from the same producer as every other session.**
`buildSessionClaims` (renamed from `buildNativeAccessClaims`, which the native
bearer path already used) delegates to `applyMembershipClaims` — the single
writer the `jwt` callback uses. An SSO token therefore carries byte-identical
claims to a password sign-in, which is the only way to be sure a gate that
passes for one passes for the other. Hand-listing claims at the call site is
what produced defect 3, and it would drift again the first time someone adds a
claim.

**The session is now TRACKED.** `recordNewSession` is called, so an SSO session
appears in `/admin/members`, can be revoked, counts toward
`maxConcurrentSessions` and honours `sessionMaxAgeMinutes`. Previously it
existed only as a cookie — invisible to the admin UI and impossible to revoke.

A fabricated `userSessionId` would not have been a shortcut:
`verifyAndTouchSession` returns `revoked: false` for an unknown id, so a made-up
value is inert rather than fail-closed.

**Failure is loud.** If claims cannot be built, the callback redirects to
`/login?error=sso_session` instead of to a dashboard the user will be bounced
off — the failure mode that hid this bug for its entire life.

## Files

| file | role |
|---|---|
| `src/lib/auth/sso-session.ts` | NEW — `establishSsoSession`, cookie name + secure-prefix derivation |
| `src/auth.ts` | `buildNativeAccessClaims` → `buildSessionClaims` (now two callers) |
| `src/app/api/auth/sso/saml/callback/route.ts` | hand-rolled mint → `establishSsoSession` |
| `src/app/api/auth/sso/oidc/callback/route.ts` | same |
| `tests/integration/sso-session-cookie.test.ts` | the closing test |

## Decisions

- **The old bug is kept as a test.** One case reproduces `jwt.sign` and asserts
  it is unreadable under *both* cookie names. It documents why that approach
  cannot work, so the next reader does not rediscover it by shipping it.

- **The positive control is not optional.** Every assertion is "getToken can
  read this", and a harness with the wrong secret makes `getToken` return null
  for everything — so a test asserting only the fixed path would pass by
  failing in the same direction it exists to detect.

- **`memberships` is asserted through `checkTenantAccess` directly**, not
  implied. That gate is what defect 3 tripped, and asserting on the claim's
  presence would not prove the gate accepts it.

- **A structural assertion sits alongside the behavioural ones.** The
  behavioural tests cannot see a THIRD callback added later repeating the
  mistake; the structural one greps both callbacks for `jwt.sign` and the v5
  cookie name. Neither substitutes for the other.

- **Renamed rather than duplicated.** `buildNativeAccessClaims` was already
  generic; adding a near-identical `buildSsoClaims` would have created exactly
  the drift this fix exists to remove.
