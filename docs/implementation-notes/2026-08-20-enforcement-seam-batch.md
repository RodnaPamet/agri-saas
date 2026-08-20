# 2026-08-20 — six enforcement seams, one batch

**Issues:** #627, #628, #630, #631, #633, #634

## Design

The 2026-08-19 Enforcement-Seam Audit asked one question of 55 seams: *would
any test fail if this enforcement line were deleted?* Sixteen times the answer
was no. This batch closes six of them.

Five share a shape and therefore a harness. `src/middleware.ts` has ~10
enforcement branches; before #635 the suites that imported the real middleware
forged tokens carrying `role: 'ADMIN'` and nothing else, so most branches were
**unreachable by construction from the only harness that could reach them**.
The mechanism got a thorough direct-import unit suite; the enforcement point got
a `readFileSync` + regex, or — in the MFA case — a local reimplementation of
itself. Green forever.

The sixth (#627) is not middleware and does not share the fixture; it is a
wiring guard in the shape of `mailer-init-wiring.test.ts`, which exists because
`initMailerFromEnv` had the same existed-but-never-called defect.

## Files

| File | Gap | Covers |
|---|---|---|
| `tests/unit/operator-lockdown-enforced.test.ts` | 9 | MECHANISATOR lockdown, `middleware.ts:323` |
| `tests/unit/scim-rate-limit-enforced.test.ts` | 11 | SCIM tier, `middleware.ts:113` |
| `tests/unit/api-read-rate-limit-enforced.test.ts` | 12 | read tier, `middleware.ts:375` |
| `tests/unit/admin-cross-site-gate-enforced.test.ts` | 14 | `Sec-Fetch-Site`, `middleware.ts:243` |
| `tests/unit/middleware-org-gate-enforced.test.ts` | 15 | org gate, `middleware.ts:344` |
| `tests/guards/shutdown-init-wiring.test.ts` | 7 | `installShutdownHandlers()` wiring |

## Decisions

- **Every refusal pins the distinguishing reason, never the bare status.** Ten
  gates sit in sequence and several answer 403. `operator_scope`,
  `cross_tenant_access_denied`, `Admin access required`, `MFA verification
  required` and `no_tenant_access` are all 403 on an API path. A status-only
  assertion passes for the wrong gate — measured, not theorised: mutating the
  operator lockdown's API arm to a generic `forbiddenJson()` still returns 403,
  and fails only the five assertions that read the reason string.

- **Every file carries positive controls proving the earlier gates were
  passed.** Without them a middleware that refused everything would satisfy
  every refusal assertion. The controls assert an exact `200` plus
  `x-middleware-next: '1'`, which is reachable only through the full gate
  sequence.

- **The membership-key trap is the reason the controls matter.** `validToken`
  built `{ tenantId, tenantSlug, role }`; production builds `{ slug, role,
  tenantId }` (`auth.ts:208`) and `checkTenantAccess` scans `m.slug`
  (`guard.ts:326`). With the wrong key every tenant-path request is 403'd by
  the tenant gate before reaching the branch under test — and the refusal
  assertions still pass. Only the controls catch it. Fixed in #635; these files
  depend on that fix.

- **The per-IP SCIM ceiling is the assertion carrying the security claim.** A
  per-bearer budget alone describes a limiter an attacker walks straight past,
  because rotating a fresh guess per request earns a fresh bucket every time.
  The test drives 601 requests with a **different bearer each time**.

- **#627 is structural and says so.** `installShutdownHandlers()` had three
  references in the repo: the import, the call, and the test that calls it
  itself. A grep-shaped guard is the honest tool for "this call site exists",
  and the docblock states plainly what it cannot catch.

- **Admin paths are useless as "blocked" examples for the lockdown.**
  `/api/t/:slug/admin/**` never reaches `:323` — the admin gate answers
  `Admin access required` first — and the page sibling returns a 200
  pass-through. A test using an admin path passes with the lockdown entirely
  deleted. These files use `/journal` and `/tasks`.
