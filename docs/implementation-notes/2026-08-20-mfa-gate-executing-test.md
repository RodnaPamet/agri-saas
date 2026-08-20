# 2026-08-20 — MFA gate: an executing test, and a fixture that was lying

**Commit:** `<pending> test(security): drive the real MFA gate, and fix the token the harness forges`

Closes gap #5 of the enforcement-seam audit (2026-08-19).

## Design

The audit asked one question of 55 enforcement seams: *would any test fail if
this enforcement line were deleted?* For the MFA gate the answer was no.
`token.mfaPending` has exactly one reader in `src/` — the block in
`src/middleware.ts` — and deleting that block passed 13,490 tests with zero
failures.

The cause is the repo's standing severed-seam shape: the *mechanism* gets a
thorough unit suite, the *enforcement point* gets a re-implementation of
itself. `tests/unit/mfa-enforcement.test.ts:142` declares
`function simulateMiddleware(pathname, mfaPending)` under the comment
"Simulates the middleware MFA check" and asserts against that copy. It imports
only `isMfaAllowedPath` / `isTenantPath` from `guard.ts` and never references
`src/middleware.ts`, so it *structurally cannot* fail when the block is
deleted — no run needed to know that.

The fix drives the real middleware, in the harness
`session-revocation-enforced.test.ts` established: import the real
`src/middleware`, mock only `getToken` and the async rate-limit budgets, and
assert on responses.

### Two traps this hit, both of which would have produced a green lie

**1. Status alone is not evidence.** The tenant-access gate (§5) sits
immediately downstream of the MFA gate (§4) and *also* answers 403 on
`/api/t/:slug/...`. A test asserting only `status === 403` passes with the MFA
block deleted, because the neighbour refuses the same request for a different
reason. The assertions therefore pin the reason string —
`MFA verification required` versus `cross_tenant_access_denied` — which is the
only thing that distinguishes them.

**2. The forged token failed the tenant gate.** `validToken()` in
`session-revocation-enforced.test.ts` built memberships as
`{ tenantId, tenantSlug, role }`. The jwt callback builds
`{ slug, role, tenantId }` (`src/auth.ts:207-210`) and `checkTenantAccess`
scans `m.slug` (`guard.ts:326`). With the wrong key, every tenant-path request
that fixture made was refused 403 by the tenant gate — including the cases it
describes as "proceeds". Its controls assert `not.toBe(401)`, which a 403
satisfies, so this was invisible.

Correcting the key pushed requests further down the middleware than they had
ever reached, which immediately exposed a third trap: both suites mocked
`apiReadRateLimit` with a bare object literal, so `isApiReadRateLimited` — a
pure predicate the middleware calls at `:375` — read back as `undefined`.
Spreading `jest.requireActual` keeps the pure path/method predicates real and
stubs only the async budget check.

## Files

| File | Role |
|---|---|
| `tests/unit/mfa-gate-enforced.test.ts` | New. Drives the real middleware against a pending challenge: 403 with the MFA reason on tenant APIs, 307 to `/t/:slug/auth/mfa` carrying `next` on pages, slug taken from the path, both carve-outs (challenge page, enrolment API) left reachable, non-tenant paths ungated, `=== true` strictness, and a differential regression proof. |
| `tests/unit/session-revocation-enforced.test.ts` | Fixed the membership key (`tenantSlug` → `slug`), made the rate-limit mocks preserve real exports, and strengthened the "proceeds" control to assert not-403 / no `/no-tenant` so the corrected key is itself pinned. |

## Decisions

- **A new file rather than extending `session-revocation-enforced.test.ts`.**
  That file's docblock states its single purpose emphatically "so it is not
  'simplified' later", and this is a different seam. The audit's sequencing
  note suggests one batch PR over the shared fixture for gaps #5/#9/#11/#12/
  #14/#15; if that batch happens, these files consolidate cleanly — the token
  factory work is done either way.

- **Fixing the neighbouring fixture was in scope.** It is the harness the
  audit designates for the batch. Leaving a token that silently fails the
  tenant gate would have made the next five gaps hit the same wall, and the
  weak `not.toBe(401)` control would have kept hiding it.

- **No `error` claim on the MFA token.** The fail-closed case
  (`MfaDependencyFailure`) already denies via the `token.error` path at §2.
  Setting an error here would let that unrelated gate produce the pass and mask
  a removed MFA block. The case this file exists for is the normal one —
  policy required, or a verified enrolment — which sets `mfaPending` alone.

- **Verified by mutation, not by coverage alone.** Deleting
  `src/middleware.ts:251-271` makes the new suite fail 4 of 9; the pre-existing
  `mfa-enforcement.test.ts` cannot fail, as it never imports the module.
  Coverage corroborates: the block moved from every statement at zero hits
  (branch `[0, N]`, true-arm never taken) to absent from the uncovered list.

- **Note there is no typecheck backstop.** `tsconfig.json` sets no
  `noUnusedLocals`, so deleting the block leaves `isMfaAllowedPath`
  imported-but-unused in `src/middleware.ts` without even a `tsc` error.
  Nothing in the toolchain objects to removing this gate.
