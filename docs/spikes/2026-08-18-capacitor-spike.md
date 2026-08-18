# Capacitor iOS spike — definition and kill criteria

**Status:** DEFINITION ONLY. Written before any spike code exists.
**Opened:** 2026-08-18
**Verdict:** _not yet reached — see §6, to be completed at close._

> This document is written FIRST on purpose. A spike whose success criteria are
> written afterwards always succeeds. Everything in §1–§5 is fixed before code;
> §6 is filled in from observations, and §3's criteria are answered in the words
> used here, not in looser words chosen later to make them passable.

---

## 0. What we already have (the delta is narrower than usual)

This is not a desktop app being squeezed onto a phone. Verified on `main` at
`54cabb7f`:

| capability | where | state |
|---|---|---|
| Service worker, hand-rolled (not Workbox) | `public/sw.js`, 447 lines | 4 caches: `STATIC_CACHE`, `PAGE_CACHE`, `DATA_CACHE`, `BASEMAP_CACHE`, under `CACHE_VERSION 'agrent-v1'` |
| Offline write queue | `src/lib/offline/{outbox,idb-outbox,field-snapshot,use-offline-sync}.ts` | IndexedDB outbox + sync |
| SW registration / web push | `src/components/pwa/{ServiceWorkerRegistrar,PushOptIn}.tsx` | live |
| Mobile shell | `src/components/layout/{BottomTabBar,AppShell}.tsx` | live |
| Offline basemap download | `src/components/ui/map/DownloadBasemapButton.tsx` | live |
| Mobile E2E coverage | `tests/e2e/mobile/*` | 12 specs incl. `offline-basemap`, `offline-photo` |
| Camera capture from the web | `src/components/ui/file-upload.tsx` | already supports `capture={"environment"}` |

So the question is NOT "can this product work offline on a phone". It already
does. The question is what a native shell adds on top, and that list is short.

## 0.1 Why `server.url` is the only available mode

The app **cannot be statically exported**. Verified:

- `next.config.js` has no `output` key at all.
- **30 of 69** tenant `page.tsx` resolve tenant context server-side via `getTenantCtx`.
- **27 of 69** declare `export const dynamic = 'force-dynamic'`.
- **41 of 69** are `async` server components; only 26 are `'use client'`.
- Auth is a NextAuth v4 HttpOnly cookie session, with middleware gating
  `/api/t/:slug` on a JWT `tenantSlug` claim.

Capacitor's usual model — bundle assets, serve from `capacitor://` — would
require re-architecting ~30 server components into client components. That is
most of a rewrite, i.e. the thing this spike exists to avoid deciding blindly.

**So the spike runs `server.url` mode: a native shell loading the live site.**
That is a legitimate Capacitor configuration and the only one available here. It
has two consequences the spike exists to measure, and which must not be papered
over:

1. **App Store Guideline 4.2 (Minimum Functionality).** Apple rejects apps that
   are a website in a wrapper. Native plugin use is the mitigation. Rejection
   risk is a FINDING, not a surprise.
2. **Nothing is bundled locally.** A cold launch with no network has no local
   shell to fall back to. Whether the existing service worker rescues this is
   the single sharpest question in the spike (§3, K2).

---

## 1. The question

> **Does wrapping the existing PWA in a Capacitor shell close the gap that
> prompted "rewrite it as an iOS app" — and if it does not, is that gap actually
> about the platform at all?**

The second clause is deliberate. The complaints that prompted this may not be
platform complaints. If the shell turns out fine and the screens turn out heavy,
that is a product finding, and a cheaper one to act on than any rewrite. The
spike is designed so that answer can surface rather than be assumed away.

---

## 2. What we hope to gain — and how the spike tells us whether we got it

Each row is kept only if it is real for THIS product. Two candidates are struck
outright, because saying so is more useful than a hopeful list.

### 2.1 App Store presence — **REAL, and unavailable today**

The only gain that is categorically impossible with the current PWA.

- **Observation that proves it:** a build passes App Review and is installable
  from the Store (TestFlight acceptance is *not* sufficient — TestFlight does
  not apply Guideline 4.2).
- **Observation that disproves it:** rejection citing 4.2 with no mitigation we
  are willing to build.

### 2.2 Background outbox delivery — **REAL, and precisely gapped today**

This is the strongest technical gain, and the repo already documents the gap.
`src/lib/offline/use-offline-sync.ts` registers the `'flush-outbox'` Background
Sync tag, and `public/sw.js:395` handles it — but **Background Sync does not
exist on iOS Safari**, and the code says so:

> _"Not present (iOS Safari, Firefox) → no-op here; the page-side `online`-event
> flush already covers reconnect-while-open."_

So on iOS today: **queued field work replays only while the app is open.** An
operator who queues work in a field, closes the app, and drives back into signal
does not sync until they next open the app.

- **Observation that proves it:** queue a field operation offline, force-quit the
  app, restore the network, do NOT reopen the app, wait; the write arrives
  server-side.
- **Observation that disproves it:** it does not arrive until the app is
  reopened — i.e. identical to the PWA, and this gain is zero.

### 2.3 Native camera — **REAL BUT NARROW**

Not "camera vs no camera": `file-upload.tsx` already supports
`capture={"environment"}`, which opens the camera directly on iOS. The gain is
taps, control over dimensions/compression, and 4.2 mitigation.

- **Observation that proves it:** the P4 comparison table shows fewer taps AND
  smaller bytes-on-the-wire at equal or better usable quality.
- **Observation that disproves it:** parity or worse on both — in which case its
  only remaining value is as 4.2 mitigation, and it should be described that way
  rather than as a feature.

### 2.4 Native push — **REAL BUT NARROW**

iOS 16.4+ supports web push for installed PWAs, and `PushOptIn.tsx` already uses
it. The gain is delivery reliability with the app killed, and lock-screen
presentation.

- **Observation that proves it:** a notification arrives with the app fully
  killed, and tapping deep-links to the correct screen, in a case where the web
  push path demonstrably does not.
- **Observation that disproves it:** both transports behave the same.

### 2.5 Storage durability — **REAL IN PRINCIPLE, PROBABLY FORFEITED BY `server.url`**

Native apps get storage iOS does not reclaim the way it reclaims web storage.
**But in `server.url` mode the caches and IndexedDB belong to the remote origin
and remain web storage**, so the shell plausibly inherits the same eviction
behaviour rather than escaping it.

This is called out here, in advance, because it is the gain most likely to be
*assumed* and least likely to be *delivered*.

- **Observation that proves it:** §3 K4's overnight test finds caches and outbox
  intact in the shell under conditions where the PWA in Safari lost them.
- **Observation that disproves it:** both lose them, or the shell loses them.

### 2.6 STRUCK — better map performance

`MapCanvas` is MapLibre GL. In `server.url` mode it renders through WebGL in the
same WKWebView Safari uses. **There is no mechanism by which the shell makes the
map faster.** If the map feels better in the shell, suspect measurement error.

### 2.7 STRUCK — "it will feel like a real app"

Not a gain, because it is not an observation. Anything real under this heading
belongs in P2.4 as a specific defect ("the header bounces on scroll", "the back
gesture navigates the wrong way"), each of which is separately fixable and none
of which requires a rewrite to fix.

---

## 3. Kill criteria — agreed in advance

The spike **fails** if any of these is met. Each is a number or an observation.
"Feels slow" is not a criterion and does not appear here.

### K1 — App Store rejection under Guideline 4.2, with no mitigation we will build
**Decides on:** a written rejection citing 4.2, received AFTER native camera
(P4) and native push (P5) are wired and submitted as mitigation.
A rejection before those are wired is not K1 — it is an incomplete submission.

### K2 — the offline stack does not survive the WKWebView
**Decides on:** any of —
- the service worker does not register (evidenced by its own logging or by cache
  contents, **not** by absence of errors); or
- fewer than four of `STATIC_CACHE` / `PAGE_CACHE` / `DATA_CACHE` /
  `BASEMAP_CACHE` populate, checked by name; or
- **airplane-mode cold launch shows a failure screen rather than the cached
  shell**; or
- a write queued offline is lost, or arrives duplicated, after reconnect.

…**and** the fix is a larger job than rewriting the six screens we actually care
about. The second clause matters: a failure with a cheap fix is not a kill.

### K3 — cold launch on rural LTE is materially worse than the PWA
**Decides on:** median over 5 cold launches, same device, same network, same
day, against a PWA baseline measured in the same session (baseline first — an
unmeasured baseline makes this criterion unanswerable):

- shell exceeds PWA time-to-first-meaningful-paint by **more than 50%, or more
  than 3 seconds absolute — whichever is smaller**; or
- shell transfers **more than 1.5×** the PWA's bytes for the same journey.

### K4 — iOS silently evicts the outbox
**Decides on:** after the app is backgrounded for the longest interval the time
box allows (target: one night, ≥12h), any queued outbox entry is gone without
having been delivered.

This is **data loss**, not a performance regression, and it kills the spike on
its own regardless of every other result.

### K5 — a real operator cannot complete the field loop
**Decides on:** one operator, on their own device, unassisted, cannot complete
locations → parcel → map → record field operation → attach photo. Their failure
point is recorded verbatim.

### Which of these do we genuinely expect might fire?

**K2's third clause and K4.** These are not hedges — they are the two we would
bet on. In `server.url` mode nothing is bundled, so an offline cold launch
depends entirely on a service worker waking up in a fresh WKWebView process
before the navigation fails; and §2.5 argues the shell probably does not escape
web-storage eviction at all. If the spike dies, we expect it dies here.

---

## 4. Time box

**5 elapsed working days, of which ~2 are hands-on device time.** K4 needs real
wall-clock backgrounding and therefore **starts on day 1** — it is the only test
that cannot be compressed, and scheduling it late is how it silently gets
dropped.

**On expiry with the question unresolved: we STOP and report INCONCLUSIVE.**
We do not extend. §6 then records what is still unknown and the next cheapest
experiment. An honest "we ran out of road" is more useful than a guess, and the
whole value of a time box is that it is allowed to expire.

---

## 5. What this spike is NOT

- **It does not ship to users.** No TestFlight-to-customers, no Store submission
  beyond what K1 requires to get a review verdict.
- **It does not enter `main`'s CI.** No workflow changes, no new required checks.
- **It does not enter the Docker image.**
- **It adds nothing to the web build's `package.json`.** A web build must not
  pull one byte of Capacitor.
- **It does not get tests written against it.** The 1,628 test files are not
  touched. Spike code is not held to production standards *and must never be
  treated as production code because it happens to exist.*
- **It does not merge.** Its fate is decided in §6.4: deleted, or parked on a
  named branch that this document points at by commit.

---

## 5.5 Findings log — written as the spike runs

Appended in order. Desk findings (answerable by reading the codebase) are marked
**[DESK]**; device observations are marked **[DEVICE]** and may only be filled in
from an actual device.

### F1 [DESK] — the shell scaffold is isolated from the app, proven by mutation

`spike/capacitor-ios/` has its own `package.json`; the web build resolves no
`@capacitor/*`. Isolation needs two config lines, and they were verified rather
than assumed:

- **With** `spike` in `tsconfig.json`'s `exclude`: `tsc --noEmit` exits 0.
- **Without** it: `tsc` exits 2 with
  `spike/capacitor-ios/capacitor.config.ts(1,38): error TS2307: Cannot find
  module '@capacitor/cli'` — i.e. the root `include: ['**/*.ts']` really would
  sweep the spike into the app's typecheck.

`npm run lint` exits 0 and 581 guard/guardrail suites (7,449 tests) pass with the
spike present. Both config lines exist **only on the spike branch**.

### F2 [DESK] — OAuth in an embedded webview may block the auth criterion outright

Found by reading `src/auth.ts` and `deploy/env.prod.example`, before any device
time. This was **not anticipated by §3's criteria**, and is recorded here rather
than retrofitted into them.

Production sets `AUTH_CREDENTIALS_UI_HIDDEN=1`, so `/login` hides the
email/password form. Real operators sign in with **Google** or **Microsoft
Entra**. Both are off-origin navigations, so Capacitor needs
`server.allowNavigation` — but that only settles Capacitor's layer.

**Google refuses OAuth from embedded webviews** (`disallowed_useragent`), as an
anti-phishing measure. `allowNavigation` does not change Google's mind.

Why this matters more than a configuration detail: the standard mitigation is
`@capacitor/browser` (`ASWebAuthenticationSession`), which is a **separate native
auth flow**. If that is required, the honest description of the result is no
longer "we wrapped the PWA" — it is "we wrapped the PWA and hand-built native
authentication", and the session cookie then has to cross from that auth session
into the WKWebView, which is precisely the thing to verify rather than assume.

**Consequence for the runbook:** the OAuth check is the cheapest possible kill
and now runs FIRST, before any other device work. The credentials route is still
reachable (only the UI is hidden), so a password sign-in can unblock the rest of
the runbook — but any result obtained that way is testing a path production
operators do not use, and the auth criterion stays unanswered.

### F3 [DEVICE] — everything in P2.3 and P2.4 remains open

The scaffold cannot be built, signed or installed from the Linux workstation this
was written on. `npx cap add ios` and everything downstream requires macOS +
Xcode + a provisioning profile. No observation in §6 may be inferred from the
scaffold's existence.

---

## 6. Verdict — completed at close

_To be filled in per P6. Each K is answered in the wording above._

| criterion | verdict | evidence |
|---|---|---|
| K1 — Guideline 4.2 rejection | — | — |
| K2 — offline stack in WKWebView | — | — |
| K3 — cold launch vs PWA | — | — |
| K4 — outbox eviction | — | — |
| K5 — operator field loop | — | — |

**Recommendation:** one of SHIP THE SHELL / REWRITE THE CLIENT / INCONCLUSIVE.

**Guideline 4.2 position:** _mitigated by native plugins, or a real blocker._

**Fate of the spike code:** _deleted, or parked at `<branch>@<commit>`._

---

## Appendix — execution constraints

The device half of this spike (P2.3–2.4, all of P3, P4.1–4.4, P5's device
comparison) **requires macOS + Xcode + a physical iPhone + an Apple Developer
account**. It cannot be run from the Linux workstation this document was written
on, and no part of §6 may be filled in from inference — an invented observation
is worse than an absent one. Where a question is answerable by reading the
codebase instead, it is answered in the desk-analysis sections rather than
deferred to the device.
