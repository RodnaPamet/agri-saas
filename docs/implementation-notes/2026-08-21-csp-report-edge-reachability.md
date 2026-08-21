# 2026-08-21 — CSP violation reporting was never reachable (#704)

**Commit:** `see git log` fix(security): CSP reports reach the sink, and the summary stops being world-readable

## Design

Two changes that must land together, in this order:

1. **Gate the summary `GET`** with `verifyPlatformApiKey`, in the handler.
2. **Then** add `CSP_REPORT_PATH` to `PUBLIC_PATH_PREFIXES` so the `POST` sink
   is reachable.

Landing (2) alone is worse than the bug it fixes — see Decisions.

## The bug

`csp.ts:184` emits `report-uri: CSP_REPORT_PATH`, and `middleware.ts:515-522`
emits the same constant in `Report-To` and `Reporting-Endpoints`. Browsers POST
violation reports there **without credentials** — the sink's own docblock says
so. The path was not public at the Edge, so `getToken()` returned null and the
middleware answered `unauthorizedJson()` before the handler ran.

The same file that advertises the endpoint refused it, a few hundred lines
apart. No report had reached the store since the feature shipped on 2026-03-21
— 153 days. The ring buffer was permanently empty, the admin summary
permanently zero, and `csp.ts:16` told operators to "monitor" something that
could not happen. Five months of CSP tightening shipped with its observation
layer disconnected.

## Files

| file | role |
|---|---|
| `src/lib/auth/guard.ts` | `CSP_REPORT_PATH` added to `PUBLIC_PATH_PREFIXES` — as the CONSTANT |
| `src/app/api/security/csp-report/route.ts` | `GET` now requires `PLATFORM_ADMIN_API_KEY` |
| `src/app/api/csp-report/route.ts` | **deleted** — legacy forwarder, no header pointed at it |
| `src/lib/errors/route-exemptions.ts` | its exemption entry removed with it |
| `tests/unit/csp-edge-reachability.test.ts` | **new** — drives the real middleware; the class enumerated |
| `tests/unit/csp-summary-gate.test.ts` | **new** — the executing test that actually holds the gate |
| `tests/guards/public-routes-self-authenticate.test.ts` | calls the real `isPublicPath` instead of regexing the source |
| `CLAUDE.md`, `docs/security-hardening.md` | the claims this invalidates |

## Decisions

- **The naive fix is actively harmful, and the two halves had to land
  together.** `getViolationSummary` returns `recentViolations: CspViolation[]`
  — the whole objects, including `clientIp` and `userAgent` — from a single
  GLOBAL 500-entry ring with no tenant scoping. The `GET`'s only protection was
  a comment saying the middleware requires auth: no `route-permissions.ts`
  entry, no `requirePermission`, no role check. So the bar was "any
  authenticated user of any tenant", and `isPublicPath` matches on PREFIX, not
  method — opening the sink would have dropped it to "anyone at all".

  The two bugs currently cancel: the POST is 401'd, so the buffer is empty, so
  the GET returns nothing worth having. **Fixing the POST is what arms the
  GET.** That is the trap, and it would have shipped looking like a one-line
  correctness fix.

- **The allowlist entry is the CONSTANT, not a literal.** The same value feeds
  three response headers. A literal in the allowlist could drift from what
  browsers are actually told — and the duplicated-literal shape is precisely
  what produced this bug. (`/api/metrics` still has it: three literals, no
  constant.)

- **That broke the existing guard, and the guard was the thing to change.**
  `public-routes-self-authenticate.test.ts` regexed `PUBLIC_PATH_PREFIXES` out
  of `guard.ts` capturing **string literals only**, so a constant entry was
  invisible and the guard failed on a correct fix. It now calls the real
  `isPublicPath`. Strictly stronger: it also honours `PUBLIC_PATH_EXACT` and
  `STATIC_EXTENSIONS`, which the local mirror never knew about, and it makes
  that file partly an *executing* test. The old "guard is inert" throw is
  replaced by a resolving-power check (`isPublicPath` must still answer true to
  one known-public and false to one known-private path).

- **Direction B could not hold the gate, so a separate executing test does.**
  I mutation-tested it: comment out the `verifyPlatformApiKey(request)` call and
  the guard stays **green**, because its `VERIFIES` check matches file TEXT and
  the import plus docblock still mention the symbol. A disabled gate reads
  exactly like a live one. `csp-summary-gate.test.ts` calls the real handler —
  401 without a key, 401 with a wrong key, 401 with a right-length wrong key,
  **503 when no key is configured** (fails closed), 200 with the right key, and
  no summary content in any refusal body.

- **The class the older guard misses is now enumerated.** Direction A derives
  from routes that READ and VERIFY a credential; a beacon sink verifies
  nothing, so it is outside that derivation by construction. The
  uncredentialed-browser-beacon class has exactly three members in this repo —
  the CSP sink, `/api/metrics`, the PWA manifest — and all three are asserted
  reachable. A fourth added without an entry is the next instance of this bug.

- **The legacy `/api/csp-report` forwarder was deleted, not opened.** No header
  had pointed at it since 2026-03-21; its own docblock said it could go once
  cached CSP headers expired, 153 days ago; and it fetched an origin derived
  from `request.url`. Deleting removes the primitive rather than guarding it.

- **`clientIp` was left in the buffer.** With the endpoint now platform-admin
  gated, an operator seeing reporter IPs is ordinary incident work, and the IP
  is what makes a violation burst attributable. Worth revisiting if the summary
  ever gets a broader audience.
