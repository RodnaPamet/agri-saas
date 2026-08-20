# 2026-08-20 — The platform-support gate: testing the ten places it is *used*

**Commit:** `<pending> test(security): drive the platform-support gate at every route that uses it`

Closes gap #4 of the enforcement-seam audit (2026-08-19) — the one it calls
"highest residual blast radius of anything left".

## Design

The task this came from was recorded as *"`assertPlatformSupport` has no
executing test."* That framing is wrong, and acting on it would have rebuilt
something that already exists.

`tests/unit/platform-support-gate.test.ts` has imported the real function and
driven it since #350 (2026-07-21) — 10 tests, 100% statement/branch/function/
line coverage of the module, including the fail-closed misconfiguration path
and the `status === 404` assertion. The function was never the gap.

The gap is one layer out. Mutation-measured on current main:

| Mutation | Tests that fail |
|---|---|
| Empty `assertPlatformSupport`'s body | 6 (the function suite) |
| Remove all 11 call sites | 1 (via the usecase site only) |
| Remove just the **10 route** call sites | **0** |

Ten route lines are the only thing between one farm's admin and the global
catalogues that render in every tenant's feed, and nothing observed them. No
test imported any of those six route modules.

So this file drives the real route handlers. `getTenantCtx` and the downstream
effects are mocked; `assertPlatformSupport`, `requirePermission` and
`withApiErrorHandling` stay real.

### Why "the effect was not called" is the load-bearing assertion

Each mocked effect is the first thing its handler does after the gate, so
asserting it was *not* called reads directly on whether the gate stopped
execution — not merely on what status came back. A route that returned 404
while still running the handler would be no protection at all.

### Why 404 and not 403

The audit's prescription said "asserting 403". The gate actually throws
`notFound` (`platform-support.ts:79`), deliberately: from another tenant's
perspective the console does not exist, and a 403 would confirm that a
global-catalogue surface is there to be found. The test asserts what the code
does, and says why in a comment so the next reader does not "fix" it to 403.

### Coverage of the axis that matters

`admin.manage` resolves from **Role**, so every tenant's OWNER holds it. A
test that only varied role would pass with the gate deleted. The axis here is
tenant identity, so the cases vary the slug and hold the role admin-grade —
plus one case asserting an OWNER is refused exactly as an ADMIN is.

## Files

| File | Role |
|---|---|
| `tests/unit/platform-support-route-gate.test.ts` | New. Parameterised over all ten gated verbs across six route modules, in three groups: a non-platform tenant is refused 404 and never reaches the catalogue; the platform tenant is let through (so the gate is not simply always-closed); and with `PLATFORM_TENANT_SLUG` unset even the platform tenant is refused (fail-closed). |

## Decisions

- **`NextRequest`, not `Request`.** `withApiErrorHandling` reads
  `req.nextUrl.pathname` (`api.ts:128`) for its route label. A plain `Request`
  has no `nextUrl`, so every case died before reaching the gate — a failure
  that looks like a broken gate and is actually a broken harness.

- **`@/env` mocked by overlaying, not replacing.** The function-level suite
  can swap `env` for a bare `{ PLATFORM_TENANT_SLUG }` literal because it pulls
  in almost nothing. A route test reaches prisma, storage and observability,
  all of which read env at module load, so this spreads `requireActual` and
  overlays the one key.

- **Positive cases assert `not 404` rather than 200.** Some handlers continue
  into body parsing this test does not bother to satisfy. What must not happen
  is the gate's own 404; asserting a specific success status would couple the
  test to each handler's payload contract for no added protection.

- **The mocked near-miss is left alone but named.**
  `tests/unit/market/manual-prices.test.ts:31` does
  `jest.mock('@/lib/auth/platform-support')` with a `jest.fn()`. That is
  legitimate coverage of the *usecase* call site — it asserts the usecase calls
  the gate — but it cannot tell you the gate works, and it says nothing about
  the ten route sites. Documented in this file's docblock rather than changed.

- **Verified by mutation.** Commenting out both calls in
  `admin/promotions/route.ts` — the exact mutation the audit measured at
  2173/2173 green — now fails 5 tests. Removing all ten call sites fails 21
  of 31.
