# Enforcement-Seam Audit — agri-saas (2026-08-19)

> ## ARCHIVED — every finding in this document is CLOSED
>
> This is a historical record, not a list of open work. All 15 findings were
> closed between 2026-08-19 and 2026-08-21. **Section 2 is written in the
> present tense and describes vulnerabilities that no longer exist** — each
> heading now carries a `CLOSED` banner naming the issue, the PR, and the test
> that closes it. If you arrived here from a `grep`, read the banner before the
> paragraph.
>
> It is committed because eight files in this repository cite its finding
> numbers (*"gap #6 of the 2026-08-19 enforcement-seam audit"*), and until now
> those were references to a file that existed on one laptop, outside git.

## Status of every finding

| # | Subject | Issue | PR | Closing test |
|---|---|---|---|---|
| 1 | SSO (SAML + OIDC) minted a cookie NextAuth v4 could not read | #616 | #615 | `tests/integration/sso-session-cookie.test.ts` |
| 2 | `PLATFORM_ADMIN_API_KEY` was 401'd at the Edge before any handler ran | — | #622 | `tests/guards/public-routes-self-authenticate.test.ts` |
| 3 | `Task.description` / `Task.resolution` written unsanitised | — | #623 | `tests/unit/security/sanitize-task-fields.test.ts` |
| 4 | `assertPlatformSupport` — the route call sites, not the function | #624 | #636 | `tests/unit/platform-support-route-gate.test.ts` |
| 5 | MFA gate — `mfaPending` had one reader and its test was a copy of it | #625 | #635 | `tests/unit/mfa-gate-enforced.test.ts` |
| 6 | `Idempotency-Key` forwarding, all three offline-replay routes | #626 | #641 + #657 | `tests/unit/idempotency-forwarding-enforced.test.ts`, `tests/unit/journal-photo-route-idempotency.test.ts`, `tests/unit/journal-photo-idempotency.test.ts` |
| 7 | `installShutdownHandlers()` wiring | #627 | #640 | `tests/guards/shutdown-init-wiring.test.ts` |
| 8 | AV-scan webhook 401'd at the Edge | #617 | #619 | `tests/unit/webhook-edge-reachability.test.ts` |
| 9 | MECHANISATOR operator lockdown | #628 | #640 | `tests/unit/operator-lockdown-enforced.test.ts` |
| 10 | Custom-role permission resolution | #629 | #639 | `tests/unit/custom-role-resolution-enforced.test.ts` |
| 11 | SCIM-tier rate limit | #630 | #640 | `tests/unit/scim-rate-limit-enforced.test.ts` |
| 12 | API read-tier rate limit | #631 | #640 | `tests/unit/api-read-rate-limit-enforced.test.ts` |
| 13 | HIBP branch on change-password / reset-password | #632 | #638 | `tests/unit/password-routes-hibp.test.ts` |
| 14 | Cross-site admin guard (`sec-fetch-site`) | #633 | #640 | `tests/unit/admin-cross-site-gate-enforced.test.ts` |
| 15 | Org-access gate | #634 | #640 | `tests/unit/middleware-org-gate-enforced.test.ts` |

Findings 2 and 3 never had issues — they were fixed directly, before the
numbering convention settled. Their narratives survive in the PR bodies.

**The most reusable thing here is not a finding.** Six of the fifteen — 5, 9,
11, 12, 14, 15 — turned out to be one missing test wearing six hats: they all
needed the same fixture (`tests/unit/session-revocation-enforced.test.ts`) to
grow its token factory. Recognising that closed all six in a single PR (#640)
instead of paying the harness cost six times. When a backlog of test gaps
shares a subject, look for that shape first.

**And two findings were mis-stated in ways worth remembering.** Finding 4 says
`assertPlatformSupport` has no executing test; the *function* had one since
#350 — the real gap was its ten route call sites. Finding 6 prescribes "drive
twice, assert one row", which is *vacuous* on the third route, whose dedup is
content-addressed. A prescribed closing test is a hypothesis, not a spec.

---

**Scope:** 55 enforcement seams across four categories (auth transports, authorization, content safety, infrastructure). For each: *would any test fail if the enforcement line were deleted?* 15 numbered findings, each of which survived an adversarial refutation pass including mutation experiments. (The original text said "16" — finding 1 counts SSO twice, SAML and OIDC. Corrected on archival; see the status table above.)

---

## 1. Verdict

**Systemic, not unlucky.** `token.error`, `iflk_` and SCIM were the three instances someone happened to trip over; the shape that produced them is the repo's default testing posture for anything that lives in `src/middleware.ts` or at a route boundary. The pattern is stable across all four categories: the *mechanism* gets a thorough direct-import unit suite (17 assertions on `shouldBlockAdminRequest`, an escalation suite on `parsePermissionsJson`, a full 429-shape suite on `checkScimRateLimit`), and the *enforcement point* gets either a `readFileSync` + regex or a local reimplementation of itself. `tests/unit/mfa-enforcement.test.ts:141` literally declares `function simulateMiddleware(pathname, mfaPending)` under the comment `// Simulates the middleware MFA check` and asserts against that — thirty lines below the `token.error` bug, in the same file, with the same fix already applied next door and not generalised. The structural cause is countable: `src/middleware.ts` has roughly ten enforcement branches; six test files import the real middleware export; four of those six `jest.mock` the rate-limit modules out; and the tokens they forge carry `role: 'ADMIN'` with no `mfaPending`, no MECHANISATOR membership, and no org claims — so most branches are unreachable by construction from the one harness that could reach them. Two amplifiers make it self-perpetuating. First, `src/lib/auth/guard.ts:279` and `tests/integration/middleware-org-gate.test.ts:6` both carry docblocks asserting that E2E covers the wiring branches; it does not, and one of them names a file (`tests/unit/middleware-org-route.test.ts`) that has never existed in the repo's history. Second, Playwright boots with `AUTH_TEST_MODE=1 NEXT_TEST_MODE=1` and CI sets `RATE_LIMIT_ENABLED=0`, so *no* E2E spec can ever observe *any* rate limiter — the tier that normally rescues middleware wiring is structurally disabled for a whole subsystem.

**Calibration, because it matters:** most of these are regression-detection gaps on code that works today, not dead features. Four are genuinely broken or inert in production right now (SSO ×2, platform-admin key, AV webhook). One is a live data defect (`Task.description` persisted unsanitised). The rest are load-bearing lines that currently execute correctly and would fail silently the day someone refactors around them. The codebase is not riddled with broken authorization; it is riddled with authorization nobody would notice breaking.

---

## 2. Confirmed gaps, by blast radius

### Broken right now

**1. SAML *and* OIDC SSO mint a session cookie NextAuth v4 cannot read.**

> **CLOSED** — issue #616, PR #615. Closing test: `tests/integration/sso-session-cookie.test.ts`
`sso/saml/callback/route.ts:194-206` and `sso/oidc/callback/route.ts:234-239` both `jwt.sign(...)` an HS256 **JWS** into `authjs.session-token` / `__Secure-authjs.session-token`. The app is NextAuth **v4.24.15**: the cookie is named `next-auth.session-token` and decoded with `jose.jwtDecrypt` (a JWE). Two independent, individually-fatal defects — fixing only the cookie name leaves it just as broken. The assertion validates, the identity links, the user is redirected to `/t/<slug>/dashboard`, and middleware bounces them to `/login`. Both prod and dev branches are wrong. `src/app/api/auth/register/route.ts:228` carries a comment asserting the v5 name, which is probably the shared misconception that seeded both. Nobody has noticed, which is itself the finding: no tenant has completed an SSO login.
→ *Closing test:* drive the real callback handler with a stubbed IdP response, feed the resulting `Set-Cookie` into the real `getToken`, assert it returns a token — with a positive control minted via `encode()` from `next-auth/jwt` so a broken harness cannot pass.

**2. `PLATFORM_ADMIN_API_KEY` is 401'd at the Edge before any handler runs.**

> **CLOSED** — no issue (predates the numbering convention), PR #622. Closing test: `tests/guards/public-routes-self-authenticate.test.ts`
Nine route files call `verifyPlatformApiKey(req)`; `/api/admin` is not in `PUBLIC_PATH_PREFIXES`, so `src/middleware.ts:126` returns `unauthorizedJson()` for a request bearing only `X-Platform-Admin-Key`. Verified by driving the real middleware. Sharper than plain unreachability: `middleware.ts:219-234` lets a request through if it carries a tenant-scoped ADMIN/OWNER JWT, so the mechanism runs *only* for callers who don't need it — an authorization inversion where a tenant role has become the prerequisite for a platform-scope operation, and the credential the operator rotates grants nothing. Tenant bootstrap, ownership transfer, agri-events, news-derived-events review, support-scheme review are all unreachable by their documented caller. `tests/guardrails/api-permission-coverage.test.ts:187` excludes these four route families with the reason "Platform-admin-key-gated" — the one guardrail that sees them defers to a mechanism that never runs.
→ *Closing test:* `/api/admin` carve-out in `PUBLIC_PATH_PREFIXES` + a middleware-crossing test asserting a key-bearing, cookie-less POST reaches the handler, plus the SCIM-shaped derived guard requiring every `src/app/api/admin/**` route to self-authenticate.

**3. `Task.description` / `Task.resolution` are written unsanitised, and the guardrail reports green.**

> **CLOSED** — no issue (predates the numbering convention), PR #623. Closing test: `tests/unit/security/sanitize-task-fields.test.ts`
`task.ts:108` (`create`) and `:174` (`update`) pass `input`/`patch` through untouched; so do `setTaskStatus:300` and `bulkSetTaskStatus:833` for `resolution`. Both fields are in `ENCRYPTED_FIELDS`. `tests/guardrails/sanitize-rich-text-coverage.test.ts:57` maps `Task` to `task.ts` and checks *file-level* — satisfied by the unrelated `TaskLink.note` and `TaskComment.body` call sites. A reviewer asking "is Task covered?" gets a yes. Not exploitable in today's UI (React escapes it; no `dangerouslySetInnerHTML` site reads it), but every row persisted since the feature shipped carries live markup for the next PDF export, share link or SDK consumer. The live surface is `createFarmTask` → `createTask`, so the fix belongs in the usecase, not the REST route.
→ *Closing test:* four driven assertions in `sanitize-write-paths.test.ts` (create/update/setStatus/bulkSetStatus with an XSS payload), and change the coverage guardrail to assert the sanitiser is called on the *manifest fields*, not merely present in the file.

### Live, load-bearing, one refactor from silent failure

**4. `assertPlatformSupport` — eight route lines are the only thing separating a farm's admin from the global catalogues.**

> **CLOSED** — issue #624, PR #636. Closing test: `tests/unit/platform-support-route-gate.test.ts`
`requirePermission('admin.manage')` sitting beside it resolves from `Role`, so every tenant's OWNER/ADMIN holds it. `promotion-admin.ts:4` states the gate lives *at the route*; Promotion/Company have no `tenantId` and no RLS; `uploadPromotionImage` receives no ctx at all. Delete a line and any tenant admin publishes into every tenant's feed and GETs supplier contact PII decrypted. Mutation-verified: commenting out both calls in `admin/promotions/route.ts` left 2173/2173 tests green. (`admin/market-prices/route.ts:26` is the one site with a real second layer.)
→ *Closing test:* one parameterised route test per verb driving the real handler with a non-platform-tenant ctx, asserting 403.

**5. MFA gate — `mfaPending` has exactly one reader, and its test is a copy of that reader.**

> **CLOSED** — issue #625, PR #635. Closing test: `tests/unit/mfa-gate-enforced.test.ts`
`middleware.ts:251` is the sole read in all of `src/`. Deletion-verified: I removed the whole 249-269 block and ran 660 unit suites (13490 tests) plus 586 guard/guardrail suites (7491 tests) — zero failures, no structural guard even greps for it. `tests/e2e` contains no occurrence of "mfa". Narrowing: the *fail-closed* sub-case survives incidentally because `auth.ts:589` also sets `token.error`, which task #48 did wire an executing test for. What is unprotected is the **normal** case — tenant policy REQUIRED, or OPTIONAL with a verified enrolment — which sets `mfaPending` with no `token.error`.
→ *Closing test:* in `session-revocation-enforced.test.ts`'s existing harness, `validToken({ mfaPending: true })` → 403 on `/api/t/acme/tasks`, 307 to `/t/acme/auth/mfa` on a page, pass-through on the two carve-outs, and green without the flag.

**6. Offline outbox exactly-once: the `Idempotency-Key` header read is forwarded by three routes and asserted by nothing.**

> **CLOSED** — issue #626, PR #641 + #657. Closing test: `tests/unit/idempotency-forwarding-enforced.test.ts, tests/unit/journal-photo-route-idempotency.test.ts, tests/unit/journal-photo-idempotency.test.ts`
`journal/route.ts:99`, `locations/[id]/operations/route.ts:22`, `journal/[id]/files/route.ts:41`. Both halves are tested against themselves: the client guard greps `sync.ts` for `'Idempotency-Key': item.id`; the three usecase suites pass the key as a positional argument; `journal-offline-create.spec.ts` drains **once** and asserts one row, which holds identically with the forwarding removed. The usecase params are optional, so deletion doesn't even fail typecheck. `offline-photo.spec.ts` docblocks the exactly-once contract in prose while counting `uploadPosts` and only ever asserting `toBe(0)` while offline. The failure mode is the flaky-LTE retry the whole design exists for: a duplicated spray or harvest record in the БАБХ log.
→ *Closing test:* drive each real route handler twice with the same `Idempotency-Key` header and assert one row + the same id returned.

**7. Graceful shutdown — `installShutdownHandlers()` at `src/instrumentation.ts:98` has three references in the repo: the import, the call, and the test that calls it itself.**

> **CLOSED** — issue #627, PR #640. Closing test: `tests/guards/shutdown-init-wiring.test.ts`
No test loads `instrumentation.ts`. Its neighbour ten lines up got `tests/guards/mailer-init-wiring.test.ts` written *precisely because* `initMailerFromEnv` had existed-but-never-been-called. Delete line 98 and 100% of the shutdown unit tests stay green while every rolling deploy drops per-tenant audit-stream buffers — irreversible, and deliberately not gated by `/api/readyz`, so nothing surfaces it. Adjacent and unchased: `scripts/worker.ts` never calls it at all.
→ *Closing test:* a wiring grep (deletion-only, matching the mailer guard) **plus** a `register()`-driven test asserting the handler set is installed after the `init*` calls.

**8. AV-scan webhook is 401'd at the Edge — dormant, will fail on first use.**

> **CLOSED** — issue #617, PR #619. Closing test: `tests/unit/webhook-edge-reachability.test.ts`
`/api/storage` is absent from `PUBLIC_PATH_PREFIXES` while `/api/scim/` sits there with a 30-line docblock about this exact failure. Zero test-tree references to `/api/storage`, `x-av-signature` or `FILE_QUARANTINED`. Not a live outage: the synchronous ingest path resolves every upload before `markStored`, and the agrent stack runs `AV_SCAN_MODE=disabled`. But the secret is provisioned in Terraform, `AV_WEBHOOK_SECRET` is documented as REQUIRED in prod, and `av-scan.ts:319` describes the symptom — "nothing in this system ever moves a file OFF pending" — as if it were a design fact. It will 401 the day someone points ClamAV at it.
→ *Closing test:* carve-out + the SCIM triple (reachability test with negative control, derived self-authentication guard, e2e asserting the handler's error shape rather than the Edge's).

**9. MECHANISATOR operator lockdown**

> **CLOSED** — issue #628, PR #640. Closing test: `tests/unit/operator-lockdown-enforced.test.ts` — `middleware.ts:321`, called "the load-bearing lockdown" in its own comment; `operator_scope` appears in zero test files. No seed, fixture or e2e util anywhere creates a MECHANISATOR membership, so Playwright cannot reach it either. `canRead('MECHANISATOR')` is true and tenant reads authorize via `assertCanRead`, so the only other layer is the UI shell. Live today; a refactor of the membership lookup (`memberships?.find(m => m.slug === slug)`) opens every tenant read API to the operator persona.
→ *Closing test:* real middleware, token with a MECHANISATOR membership, assert 403 `operator_scope` on a non-allowlisted API path and redirect to `/my-work` on a page.

**10. Custom-role permission resolution**

> **CLOSED** — issue #629, PR #639. Closing test: `tests/unit/custom-role-resolution-enforced.test.ts` — `tenant-context.ts:120` is the ternary that turns `permissionsJson` into `ctx.appPermissions`. No `TenantCustomRole` row exists anywhere outside jest mocks; every test that drives `resolveTenantContext` for real uses plain enum roles. The OWNER-clamp suite's "end-to-end assertion" is a *comment* about what `requirePermission` reads. Because `assignCustomRole` leaves `membership.role` untouched, an inert branch fails **open** for narrowing roles — the entire point of the feature.
→ *Closing test:* `resolveTenantContext` with a `customRoleId`-bearing membership, assert `ctx.appPermissions` reflects the JSON and not `getPermissionsForRole(role)`.

**11. SCIM-tier rate limit**

> **CLOSED** — issue #630, PR #640. Closing test: `tests/unit/scim-rate-limit-enforced.test.ts` — `middleware.ts:111-114`, the only budget on what its own comment calls an anonymous bearer-guessing oracle; the read and mutation tiers structurally cannot cover it. Deletion-verified: 18 suites, 185 tests, zero failures. Not even a source grep names the call site. `scim-edge-reachability.test.ts` does execute the line but fires nine requests against a 300/600 budget.
→ *Closing test:* one case in that file with the test-mode envs unset, `RATE_LIMIT_MODE=memory`, rotating bearers past `SCIM_IP_LIMIT`, asserting 429.

**12. API read-tier rate limit**

> **CLOSED** — issue #631, PR #640. Closing test: `tests/unit/api-read-rate-limit-enforced.test.ts` — doubly severed: the unit test hand-builds `{headers:{get}}`, the guardrail is `readFileSync` + regex, and **four of the six** real-middleware tests `jest.mock` this exact module out. Deletion-verified: one guardrail failed, on two source-text assertions. Literal removal is caught; every semantic severance (block hoisted above an early return, matcher narrowed, `isBypassed()` widened, `.pbf` exemption broadened) is invisible.
→ *Closing test:* real middleware, 121 GETs on `/api/t/<slug>/journal`, assert 429 + `Retry-After`; and stop mocking the module in the four suites that don't need it.

**13. HIBP branch on change-password / reset-password**

> **CLOSED** — issue #632, PR #638. Closing test: `tests/unit/password-routes-hibp.test.ts` — the grep guard requires the import and the call; it cannot see `if (hibp.breached) { return 400 }` deleted while the `await` stays. Mutation-verified: I removed exactly that from both routes and 589 suites / 7523 tests passed, including the guardrail. `/api/auth/register` *is* crossed (`register-route.test.ts:160` drives the real handler with `breached: true`), so the inconsistency wouldn't surface in manual testing either.
→ *Closing test:* copy `register-route.test.ts:160-167` for both password routes.

### Defence-in-depth only — real, but backstopped

**14. Cross-site admin guard (`sec-fetch-site`)**

> **CLOSED** — issue #633, PR #640. Closing test: `tests/unit/admin-cross-site-gate-enforced.test.ts` — `middleware.ts:243`. Textual deletion *is* caught by `security-hardening-epic.test.ts:224`; every behavioural severing (inverted predicate, wrong header name, narrowed `isAdminPath`, relocation behind an earlier return) is not. The session cookie is `SameSite=lax` by design, so this is a second layer, not the sole CSRF control.
→ *Closing test:* `scim-edge-reachability` shape — `{ role: 'ADMIN' }` token, `sec-fetch-site: cross-site` POST to an admin route, assert 403 + message; `same-origin` negative control asserting `x-middleware-next: '1'`.

**15. Org-access gate**

> **CLOSED** — issue #634, PR #640. Closing test: `tests/unit/middleware-org-gate-enforced.test.ts` — `middleware.ts:344`. The promised crossing test never existed. The structural guard catches deletion but not neutering: flipping `if (gateResult !== 'allow')` to a never-true condition leaves the gate permissive with everything green. All fourteen `/api/org/**` handlers resolve through `getOrgCtx`, which collapses non-members to 404 and *is* tested — so a neutering loses the early-rejection layer and the anti-enumeration parity, not the data.
→ *Closing test:* the file the docblock already names — real middleware, `orgMemberships: [{slug:'acme-org'}]`, assert `/no-tenant` redirect and `404 {error:'not_found'}` on the API path.

---

## 3. Examined and cleared

- **SCIM Edge reachability** — `scim-edge-reachability.test.ts` drives the real middleware; the e2e asserts a bad bearer yields the SCIM *Error schema*, the only assertion that distinguishes "handler ran" from "handler never ran". The reference fix, and the template for #2 and #8.
- **`iflk_` API-key disable** — `api-key-auth-disabled.test.ts` drives `getTenantCtx` and asserts `verifyApiKey` was never called; deleting `context.ts:241` fails.
- **`token.error` session revocation** — `session-revocation-enforced.test.ts` drives the real middleware end to end. The harness every gap in §2 should borrow.
- **Auth-tier rate limit** — `tests/integration/auth-ratelimit.test.ts` imports the real middleware, fires 11 requests, asserts 429 + `X-RateLimit-Limit`.
- **Mutation-tier rate limit** — `rate-limit-rollout.test.ts` wraps a handler in the real `withApiErrorHandling`, drains 60 POSTs, asserts the 61st is 429.
- **Client-version 426 gate** — real middleware, asserts the machine-readable code, not just the status.
- **`DATA_ENCRYPTION_KEY` check 1 of 3** — `env.test.ts` spawns a child process for a real module load. (Checks 2 and 3 — the startup hooks with the encrypt→decrypt sentinel, and the Compose `:?` layer — are grep-only and have never executed; not reported as separate gaps but worth knowing.)
- **Graceful-shutdown drain order** — `process.emit('SIGTERM')` against real installed handlers. The *mechanism* is fine; only its installation is unguarded (#7).
- **Epic B field encryption** — `epic-b-encryption.test.ts` writes through the real Prisma singleton and reads the row back with raw SQL; deleting `withEncryptionExtension` fails it.
- **CSP nonce patch** — `tests/e2e/security/csp-nonce.spec.ts` renders real pages under `next start` and is in the default CI e2e command.
- **Journal sanitisation** — `journal.ts:247` sanitises and `journal.test.ts:183` drives create/update with real XSS payloads through the real sanitiser. The template for #3.
- **Admin route permission denial** — `admin-route-enforcement.test.ts` drives the real route export; `admin-members.spec.ts:77` asserts a real HTTP 403 for a READER. (Caveat: 7 of 73 `requirePermission` routes have a behavioural denial test.)
- **RLS tenant isolation** — real usecases against real Postgres. **Last-OWNER protection** — usecase check + DB trigger, both driven.
- **BullMQ library seam** — `bullmq-real-api.test.ts` uses real Redis, no mocks, and asserts the module isn't a mock. (`scripts/worker.ts` / `scheduler.ts` are still outside `tsconfig` and read by neither tsc nor jest; the call shapes are hand-copied.)
- **Invite redemption, native token/handoff routes, audit-stream outbound HMAC** — all have tests that drive the real caller.

Two systemic caveats on the cleared list: every DB-backed suite sits behind `DB_AVAILABLE ? describe : describe.skip` with no `REQUIRE_DB` escalation, so it goes quiet rather than red; and `bearer-cookie-parity.test.ts` compares two middleware answers derived from an identically-mocked `getToken`, which is true by construction and never reaches the server-side `resolveBearerSession` fallback its own docblock names as the broken part.

---

## 4. Sequencing — removed on archival

The original section 4 was a work plan for gaps that are now all closed, and a
plan for finished work is the part of an archived document most likely to be
read as live. It has been removed rather than left to mislead.

Its judgements are preserved where they still mean something:

- *"#5, #9, #11, #12, #14, #15 are all the same missing test against the same
  fixture"* — correct, and it paid off: **PR #640 closed all six in one PR** by
  extending `tests/unit/session-revocation-enforced.test.ts`'s token factory.
  This is the section's most reusable insight and is recorded in the preface.
- *"#4 … highest residual blast radius of anything left"* — closed by #636,
  after the finding itself was corrected (see the note on finding 4).
- *"Leave: don't chase `sw.js` execution coverage, `.down.sql` rehearsal, or
  `deploy/apply.sh` beyond `bash -n` in this pass"* — still the right call.
  None of these were pursued.

The one forward-looking item that outlived the audit — extending
`tests/guards/behavioural-coverage-registry.test.ts` to the middleware
enforcement branches, which the audit called *"the only mechanism here that
would have caught all sixteen"* — is tracked separately, along with the two
loose threads recorded in section 3.
