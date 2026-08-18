# Capacitor iOS spike — definition and kill criteria

**Status:** DEFINITION ONLY. Written before any spike code exists.
**Opened:** 2026-08-18
**Verdict:** **INCONCLUSIVE** — see §6. No device session ran; the time box never started.

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

### F4 [DESK] — the app never requests persistent storage. K4 is the likeliest kill.

`navigator.storage.persist()` and `navigator.storage.estimate()` appear **nowhere**
in `public/sw.js`, `src/lib/offline/**`, or `src/components/pwa/**` — zero
occurrences.

Without `persist()`, all of it is best-effort storage. On iOS that means:

- Safari's ITP deletes **all script-writable storage** (Cache API, IndexedDB)
  after ~7 days without interaction with the site.
- Quota pressure evicts by origin, and this origin stores **photo Blobs**
  (`outbox.ts:74 blob: Blob`) plus a **24 MB basemap budget**
  (`BASEMAP_CACHE_BUDGET_BYTES = 24 * 1024 * 1024`). That is a large, fast-growing
  footprint for an evictable origin.
- §2.5 already argues `server.url` mode probably does not escape web-storage
  eviction, because the storage belongs to the remote origin.

So the mechanism K4 is testing is **not merely possible, it is the documented
default behaviour** for an origin that has not requested persistence. Note this
is a PWA problem too — the shell does not create it — but the spike must not
report "the shell loses data" as a shell finding if the PWA loses it equally.
**Measure both**, or the criterion answers the wrong question.

Cheap mitigation worth pricing if K4 fires: call `navigator.storage.persist()`.
On iOS it is not reliably granted, so price it as "may help", not "fixes it".

### F5 [DESK] — replay duplication is architecturally prevented (K2's fourth clause is likely safe)

`src/lib/offline/sync.ts` sends `Idempotency-Key: item.id` on every replay, and
the id is the **stable outbox id** minted at enqueue (`crypto.randomUUID()` with
a fallback, `outbox.ts:114-121`) — the same id rides every retry. Photo items
replay as multipart from the stored Blob with the same header; mutations
additionally send `If-Match` for optimistic locking.

Server-side handling exists on the journal, journal-files and location-operations
routes. So "syncs and is not duplicated" is a designed property, not luck.

**Residual risk is not duplication but Blob durability**: photo bytes live as
Blobs in IndexedDB, which is exactly the storage class F4 says iOS evicts.

### F6 [DESK] — the service worker's scope and fetch guard survive `server.url`

`ServiceWorkerRegistrar.tsx` registers `/sw.js` at the site's origin, and the SW's
fetch handler passes through anything cross-origin
(`sw.js:201  if (url.origin !== self.location.origin) return;`). In `server.url`
mode the WKWebView's origin **is** the remote site's, so scope and guard both
behave as in Safari. This lowers the risk on device tests 3.1 and 3.2.

### F7 [DESK] — the shell probably LOSES web push until P5 lands

`sw.js` registers `push` and `notificationclick` handlers and `PushOptIn.tsx`
drives `pushManager.subscribe()`. On iOS, web push is only available to a site
**added to the Home Screen as a PWA** — a Capacitor WKWebView is not that
context.

So the shell plausibly **removes** a capability the PWA has, and P5's APNs work
is not purely additive: it may be replacing something rather than adding to it.
Verify on device before crediting native push as a gain — and if web push is
indeed dead in the shell while P5 is unfinished, the shell is a net regression on
notifications, which belongs in the verdict.

### F8 [DESK] — risk-ranked pre-assessment of the six device tests

Ordered as P3 requires (cheapest kill first), with the desk view of each. This
exists so the device session is **aimed** rather than exploratory.

| # | test | desk risk | why |
|---|---|---|---|
| 3.1 | SW registers in WKWebView | **LOW** | F6: registration path and origin guard are unchanged by `server.url` |
| 3.2 | four caches populate | **LOW** | follows from 3.1; check by name, not by absence of errors |
| 3.3 | **airplane-mode COLD launch** | **HIGH** | nothing is bundled. The launch is a webview load of a remote URL; it survives only if an already-activated SW intercepts the navigation in a fresh process. There is no Capacitor-level offline fallback in `server.url` mode, so the failure mode is a blank/error view with no shell |
| 3.4 | warm offline write → sync, no duplicate | **LOW** for duplication (F5), **MEDIUM** for photo Blobs (F4) | idempotency is designed in; Blob durability is not |
| 3.5 | offline basemap + map pan | **MEDIUM** | two variables. Cache side is a 24 MB budgeted cache-first store; WebGL-in-WKWebView is separate and must be recorded separately |
| 3.6 | **overnight eviction** | **HIGH** | F4: no `persist()` call anywhere, large Blob + 24 MB basemap footprint, remote-origin storage |

**3.3 and 3.6 are where we expect this to die**, which matches what §3 already
committed to in advance. Everything above them is cheap to run and should be run
first anyway — a failure at 3.1 would make the rest moot.

### F9 [DESK] — native capture CAN join the existing outbox. No second queue.

The question P4 called "worth more than the feature" answers **YES**, from the
code, without a device.

`enqueuePhoto(store, input)` takes `{ url, blob, fileName, fileType, label }`
(`outbox.ts:205-244`). `Camera.getPhoto({ resultType: Uri })` returns a
`webPath` the WKWebView can `fetch()` straight into a `Blob`. So the native path
makes the **identical call** the web path makes — one queue, one replay loop, one
`Idempotency-Key`, one drain.

`spike/capacitor-ios/native-capture-bridge.ts` is the proof-of-shape. It is
deliberately NOT wired into `src/`: shipping untested edits to a production
component from a machine that cannot build or run the app would be worse than
shipping none, and the integration is a single call the device session applies.

One contract to respect: `EnqueuePhotoInput.blob` is documented as "the
already-downscaled photo bytes", and `enqueuePhoto` throws `PhotoTooLargeError`
above `MAX_QUEUED_PHOTO_BYTES` (8 MB). The web path downscales in a canvas;
Camera's `width`/`quality` do it natively. **That is one of the few places the
shell can be genuinely faster** — and P4's table is where it is measured rather
than asserted.

### F10 [DESK] — the camera is not a capability gain, and the gain list must say so

`file-upload.tsx` already accepts `capture?: boolean | "user" | "environment"`,
which opens the camera directly on iOS. The honest framing is **taps, bytes and
Guideline 4.2 mitigation** — not "we would get a camera".

If the comparison table comes back at parity, the native camera's entire
remaining value is 4.2 mitigation, and the verdict should describe it that way
rather than count it as a feature.

### F11 [DESK] — the scanner contract is inherited, provided no new endpoint is invented

The journal photo endpoint routes through `uploadLogEntryPhoto`
(`usecases/journal.ts:570`) → `scanUploadedBuffer` (:616) →
`FileRepository.markStored(..., scanStatus)` (:665).

A native capture reusing that URL therefore **cannot bypass the scanner** — which
is why `native-capture-bridge.ts` takes the target `url` as a parameter instead
of constructing one. Inventing an endpoint is exactly the class
`tests/guards/upload-route-scan-reachability.test.ts` exists to catch.

Also carried over from CLAUDE.md: never restore a default on the `scanStatus`
argument — `isDownloadAllowed('SKIPPED')` is true in every `AV_SCAN_MODE`, so a
default meaning "unscanned" would also mean "downloadable".

### F12 [DESK] — Bulgarian permission copy does not exist, and CI cannot see that it doesn't

iOS usage descriptions live in the Xcode project as one `InfoPlist.strings` per
locale. They are **outside next-intl**, so `i18n-completeness` and
`scripts/i18n-diff.mjs` — which hold `bg.json`/`en.json` at exact parity (5,269
keys each, 0 missing) — have no visibility into them at all.

Written here at `spike/capacitor-ios/ios-strings/{en,bg}.lproj/`, using the app's
own terminology from `messages/bg.json` (`снимки`, `полски операции`). They must
be copied into `ios/App/App/` and added to the Xcode target, or a Bulgarian
operator gets an English system prompt.

**If this shell ever became real, i18n parity would need a second mechanism.**
That is a standing cost of the native route — and it applies to a React Native
rewrite equally.

### F13 [DESK] — P5's precondition is NOT met, and its credentials do not exist

P5 runs "only if P3 and P4 came back positive". **P3 has not run at all** — its
six tests need a device. So the device half of P5 must not start, and this
section records the desk work only.

Independently, P5.1 says to stop and record a schedule finding if the Apple
Developer account, push key/certificate or provisioning profile are not in hand.
Checked: there is **no APNs credential of any kind in the repo** — no `.p8`, no
team id, no `APNS_*` env var. `src/env.ts` has only the VAPID trio
(`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`) for web push.

**This is a schedule finding, per P5.1.** Obtaining an Apple Developer account
and a push key is account administration measured in days of waiting, not hours
of work, and it is on the critical path for *any* iOS route — Capacitor shell or
React Native rewrite alike. It should be started immediately and in parallel,
because it does not discriminate between the options and it will otherwise
silently become the long pole.

### F14 [DESK] — there is no single sender today. The seam is `sendWebPushToUser`.

P5 says "find the existing sender and add a transport". Precisely: there **isn't**
one sender — `sendWebPushToUser` is called directly from two places:

- `src/app-layer/jobs/weather-pull.ts:261` — spray-window push
- `src/app-layer/usecases/task.ts:529` — task-assignment push

So the correct seam is **inside `src/lib/notifications/web-push.ts` itself**.
Adding APNs delivery within `sendWebPushToUser` gives one-sender-two-transports
for both call sites at once, with no new dispatch path. The honest shape would
rename it to something transport-neutral (`notifyUserDevices`) so the name stops
claiming a transport.

Anything hung off a *different* event would be the parallel pipeline P5 forbids.

### F15 [DESK] — where the dedupe actually lives, and why that matters here

The `{tenantId}:{TYPE}:{entityId}:{userId}:{date}` key (`buildDedupeKey` in
`enqueue.ts`, `buildAgroDedupeKey` in `agro.ts`) belongs to the **notification
record** layer, not to push delivery. `sendWebPushToUser` has no dedupe of its
own — it is a best-effort side effect of an already-deduped event, fanning out to
up to 25 subscriptions.

Consequence for the design: **adding APNs inside `sendWebPushToUser` inherits
that dedupe for free.** A separate APNs dispatcher subscribed to its own trigger
would not, and would double-notify exactly as P5 warns. This is the technical
reason the seam is where F14 says it is, rather than a stylistic preference.

### F16 [DESK] — the schema does not fit an APNs token, and that is the scope tension made concrete

`PushSubscription` (`prisma/schema/automation.prisma:50`) is shaped for Web Push:
`endpoint`, `p256dh`, `auth`. An APNs device token is a single opaque string with
none of those, so a transport addition needs either a nullable `apnsToken` column
plus a `kind` discriminator, or a second table.

Either is a **migration against production**, which is the concrete form of the
tension flagged when P5 was received: "add a transport to the existing sender"
cannot be done entirely inside a throwaway spike. The default taken here is that
**no schema change is made** — the design is recorded, not applied — because a
migration outliving a spike that may be discarded is exactly the "half a
Capacitor config found in six months" problem P6.4 exists to prevent.

If the verdict is SHIP THE SHELL, this migration is the first item of real work,
and it should land on its own merits with its own review, not as spike residue.

---

## 6. Verdict — completed at close

**Status: CLOSED — INCONCLUSIVE.** Reached 2026-08-18.

### 6.1 Every criterion, in the wording it was written in

None of the five was answered, because **no device session ran**. Each is
recorded UNANSWERED with the desk assessment that bears on it — a desk risk is
not a verdict and is not written as one.

| criterion (original wording) | verdict | evidence |
|---|---|---|
| **K1** — "App Store rejection under Guideline 4.2, with no mitigation we will build" | **UNANSWERED** | Nothing was submitted. The mitigations K1 requires *before* a submission counts (native camera, native push) are designed but not wired: F9 shows the camera can join the existing outbox; F13 shows APNs has no credentials at all. |
| **K2** — "the offline stack does not survive the WKWebView" …and the fix is "a larger job than rewriting the six screens we actually care about" | **UNANSWERED** | Split by clause. Registration/scope: LOW risk (F6). Duplication: architecturally prevented (F5). **Offline cold launch: HIGH risk, untested (F8).** The second half of the criterion — "bigger job than a rewrite" — was never reachable without the first. |
| **K3** — "cold launch on rural LTE is materially worse than the PWA" (>50% or >3s slower, or >1.5× bytes) | **UNANSWERED** | Requires a device on a real cellular network, and a PWA baseline measured in the same session. Neither exists. |
| **K4** — "iOS silently evicts the outbox" | **UNANSWERED, but the mechanism is confirmed present** | F4: `navigator.storage.persist()` appears **nowhere** in the app. Storage is best-effort by default, holding photo `Blob`s and a 24 MB basemap budget. Whether iOS actually evicted them is unmeasured — that is the difference between a hazard and a finding, and it is not blurred here. |
| **K5** — "a real operator cannot complete the field loop" | **UNANSWERED** | No operator, no device. F2 raises a prior question: whether they could even sign in. |

### 6.2 Recommendation

**INCONCLUSIVE.**

With one correction to the category, because precision matters more than fitting
the template: §4 defined INCONCLUSIVE as *"the time box expired first"*. **The
time box did not expire — it never started.** The spike was defined, scaffolded
and desk-analysed on a Linux workstation; building, signing and installing an iOS
app requires macOS + Xcode + a provisioning profile + a physical iPhone, none of
which were available. Every device observation is therefore absent rather than
negative.

That distinction is the whole point. An absent observation and a negative one
license completely different decisions, and reporting the first as the second
would have been the single most damaging thing this document could do.

**What is still unknown:** all five criteria, which is to say the spike's actual
question.

**The next cheapest experiment**, in order — the first two need no Apple account
and can be done in an afternoon:

1. **Reproduce K2's cold-launch question in mobile Safari**, not in Capacitor.
   Add the site to the Home Screen, force-quit, go offline, launch. If the PWA's
   `PAGE_CACHE` cannot serve a cold offline launch, the shell will not fix it and
   K2 is answered without ever opening Xcode. **This is the highest-value hour
   available right now.**
2. **Run K4's overnight eviction test on the PWA alone.** F4 says the mechanism is
   present; that test needs a phone and a night, not a developer account.
3. Only then: acquire the Apple credentials (F13 — days of lead time, needed for
   *any* iOS route) and run P2–P5 on hardware.

### 6.3 The third possibility — and the desk work already points at it

P6 asked for this explicitly because it is the likeliest and the easiest to miss:
**the complaints that prompted "rewrite it as an iOS app" may not be about the
platform at all.** The desk findings support taking that seriously, and two of
them are actionable today without any native work:

- **Data durability is a PWA bug, not a platform limitation (F4).** The app never
  calls `navigator.storage.persist()`. If operators are losing queued work, that
  is the first suspect, and the fix is one call — not a rewrite. A native shell in
  `server.url` mode probably does **not** fix it either (§2.5), because the
  storage stays remote-origin web storage.
- **The camera is already native (F10).** `capture={"environment"}` opens the iOS
  camera today. If capture feels bad, the cause is in the surrounding flow, not in
  the absence of a native API.

Against that, one gap is **genuinely platform-shaped** and cannot be fixed in the
PWA: **background outbox replay (§2.2)**. iOS Safari does not implement Background
Sync, the codebase says so in `use-offline-sync.ts`, and the consequence is real —
queued field work replays only while the app is open. An operator who queues in a
field, force-quits, and drives back into signal does not sync until they reopen.
No amount of web-side work fixes that.

**So the honest shape of the answer, before any device time:** of the two most
plausible operator complaints, one is a cheap PWA fix and one genuinely needs
native. That is a materially different brief from "rewrite the client", and it is
worth resolving *which complaint is actually being made* before spending the
Apple lead time.

### 6.4 App Store Guideline 4.2 — stated position

**Unresolved, and the risk is higher than the standard framing suggests.**

The usual mitigation is "use native plugins", and P4/P5 are that mitigation. But
F2 raises something prior: production hides the credentials form
(`AUTH_CREDENTIALS_UI_HIDDEN=1`), so operators sign in with Google or Microsoft —
and **Google refuses OAuth in embedded webviews**. If sign-in has to move to
`ASWebAuthenticationSession`, the app is a webview wrapper whose *only* native
code is authentication and two plugins bolted on to satisfy review. That is the
weakest possible 4.2 posture, and it is discoverable before submission rather
than after.

No position can be asserted beyond that without a review verdict, and none is
asserted here.

### 6.5 Fate of the spike code — decided and written down

**Parked, not merged.** So nobody finds half a Capacitor config in six months and
wonders whether it is load-bearing:

| branch | contents | fate |
|---|---|---|
| `spike/capacitor-ios-p2` | scaffold, `capacitor.config.ts`, device runbook | **parked, never merged** |
| `spike/capacitor-ios-p3` | offline desk analysis + `OFFLINE-RUNBOOK.md` | **parked, never merged** |
| `spike/capacitor-ios-p4` | capture bridge, `InfoPlist.strings`, camera runbook | **parked, never merged** |
| `spike/capacitor-ios-p5` | APNs seam design | **parked, never merged** |

**This document is the only artefact that reaches `main`.** That is deliberate:
the knowledge is worth keeping, the throwaway code is not, and a spike branch
that quietly merges is how spike code becomes production code by accident.

The `tsconfig.json` and `eslint.config.mjs` exclusions that isolate `spike/**`
exist **only on those branches** and never reach `main` — verified: this branch
carries no `spike/` directory and no config change.

**If the branches are still unmerged in six months, delete them.** This document
records what they contained and why, which is the part worth keeping.

---

## Appendix — execution constraints

The device half of this spike (P2.3–2.4, all of P3, P4.1–4.4, P5's device
comparison) **requires macOS + Xcode + a physical iPhone + an Apple Developer
account**. It cannot be run from the Linux workstation this document was written
on, and no part of §6 may be filled in from inference — an invented observation
is worse than an absent one. Where a question is answerable by reading the
codebase instead, it is answered in the desk-analysis sections rather than
deferred to the device.
