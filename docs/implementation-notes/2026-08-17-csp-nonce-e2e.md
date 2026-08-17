# 2026-08-17 — the CSP nonce gets an end-to-end test

**Commit:** `<pending> test(security): assert the CSP nonce on real rendered pages`

## Problem

Every nonce check in this repo read BYTES. `tests/guards/csp-nonce-component-scripts-patch.test.ts`
regexes the minified Next bundles in `node_modules`; `scripts/verify-image-patches.mjs`
does the same inside the built image. Both are good and neither renders anything.

Measured before writing this: **zero of 56 Playwright specs** referenced `nonce`
or `Content-Security-Policy`.

The gap is not theoretical. From 2026-05-14 to 2026-07-25 every deployed
container served an unnonced `<script>` that `script-src 'nonce-…'
'strict-dynamic'` blocks, and CI was green for ten weeks, because every signal
described a developer's machine or a source file rather than a rendered page.

Those guards can only catch the failure they were written for — our patch not
applying. An unnonced script arriving for another reason (a new Next code path,
a middleware regression, a header-ordering change) still ships green.

`playwright.config.ts` already runs the app under `next start` in PRODUCTION
mode in both CI and local runs. The capability was sitting there unused.

## Design

`tests/e2e/security/csp-nonce.spec.ts`, two tests:

1. For the authenticated dashboard and `/login`: make ONE request, read the CSP
   header AND the HTML from that same response, extract the nonce from
   `script-src 'nonce-…'`, and assert every executable `<script>` in the markup
   carries it. Plus a positive control that the page contained any scripts at
   all.
2. Load the app shell in a browser and assert no `securitypolicyviolation`
   fired — the markup being well-formed and the browser agreeing are two claims.

Two things the spec is deliberately careful about, both of which would have made
it quietly wrong:

- **The nonce is PER-REQUEST.** Reading a header from one navigation and markup
  from another compares two different nonces. Hence one request, both reads.
- **It asserts on server-rendered HTML, not the live DOM.** Under
  `strict-dynamic`, a correctly-nonced script may load further scripts that
  legitimately carry no nonce — trusted by delegation. Walking
  `document.querySelectorAll('script')` would flag those and be wrong. The bug
  being guarded against was a server-rendered tag, which is what the response
  body shows.

## Files

| file | role |
|---|---|
| `tests/e2e/security/csp-nonce.spec.ts` | the end-to-end check |
| `tests/helpers/csp-nonce.ts` | the pure detector, extracted so it can be mutation-proved |
| `tests/unit/security/csp-nonce.test.ts` | 14 mutation-proof cases for the detector |
| `CLAUDE.md` | the "Bumping Next" procedure now names both checks |

## Decisions

- **The detector is split out and unit-tested separately.** A green Playwright
  run proves the PAGES were clean. It does not prove the detector would have
  noticed if they weren't — and a detector that matches nothing passes forever.
  Conflating those two claims is exactly how the original bug survived. The unit
  tests include the real tag from the 2026-05-14 incident, a wrong-but-present
  nonce (blocked by the browser just like a missing one), inline scripts, and
  single-quoted / oddly-spaced attribute forms.

- **Non-executable `type`s are skipped.** `application/json`,
  `application/ld+json`, `importmap`, `speculationrules` are not script for CSP
  purposes. `type="module"` and explicit JS mime types still require the nonce
  and are tested for.

- **A positive control guards against vacuity.** If a page rendered no
  `<script>` at all — an error page, a redirect body — "no unnonced scripts"
  would be trivially true. Same fail-open the structural guard had until #588.

- **Read-only, shared seeded tenant.** Per the E2E isolation convention this
  spec navigates and asserts without mutating, so it uses `loginAndGetTenant`
  rather than an isolated tenant. `tests/guards/e2e-isolation.test.ts` passes.

## Verification

Run against a real local stack: dedicated `agri_saas_e2e` database (migrated +
seeded), `next build` in test mode, `next start`. Both tests pass.

Then the part that matters — an end-to-end mutation proof against the real
render:

```
REAL PAGE: 57 script tags; unnonced now = 0
REAL PAGE: after stripping one SCRIPT nonce -> 1 detected:
           <script src="/_next/static/chunks/5d015edf-c4e6d98f1798d13d.js" async="">
```

So on a live dashboard the detector reads 57 real script tags, finds none
unnonced, and catches exactly one when a single nonce is removed. That proves
the glue (header parse → body read → detector), not just the pure function.

The unit suite is 14/14; `tsc --noEmit` clean.

**A trap worth recording for the next person running E2E locally:**
`DATA_ENCRYPTION_KEY` must be IDENTICAL between the seed step and the webserver.
`emailHash` is HMAC-derived from it, so a mismatch surfaces as `unknown_email`
login failures that look nothing like a key problem. `playwright.config.ts`
defaults the webserver to `e2e-deterministic-test-encryption-key-32+-chars` via
shell `${VAR:-…}` expansion, so pass your own value in both places or accept the
default in both.
