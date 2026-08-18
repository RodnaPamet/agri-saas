# Capacitor iOS spike — shell scaffold + device runbook

**Throwaway.** This directory is not part of the web build, not in CI, not in the
Docker image, and contributes nothing to `package.json`. Its fate is decided in
§6.4 of `docs/spikes/2026-08-18-capacitor-spike.md`.

Read the spike definition **first**. The kill criteria there are what this
runbook is trying to answer; if you run these steps without them you will get
observations nobody agreed were decisive.

---

## Why `server.url` and not a bundled app

Verified on `main`:

| | |
|---|---|
| `next.config.js` | no `output` key at all |
| tenant `page.tsx` using `getTenantCtx` | **30 / 69** |
| tenant `page.tsx` with `force-dynamic` | **27 / 69** |
| tenant `page.tsx` that are `async` server components | **41 / 69** (only 26 are `'use client'`) |

Bundling would mean re-architecting ~30 server components into client
components. That is most of the rewrite this spike exists to avoid deciding
blindly, so `server.url` is the only configuration available.

**Its cost:** nothing is bundled locally, so an offline cold launch has no local
shell. Whether `sw.js`'s `PAGE_CACHE` rescues that is kill criterion K2.

---

## Isolation — what keeps this out of the app

| mechanism | why |
|---|---|
| own `package.json` here | the web build never resolves `@capacitor/*` |
| `spike/**` in root `tsconfig.json` `exclude` | root `include` is `**/*.ts`; without this, `tsc --noEmit` compiles `capacitor.config.ts` and fails on unresolvable `@capacitor/cli` |
| `spike/**` in `eslint.config.mjs` `ignores` | same reason, for `npm run lint` |
| `ios/`, `node_modules/` gitignored | the Xcode project is regenerable; it is not a source artefact |

Those two config lines exist **only on the spike branch**. `main` is untouched
because the branch does not merge.

---

## Setup (macOS + Xcode required)

```bash
cd spike/capacitor-ios
npm install
# Point at a real https origin. Prod:
export SPIKE_SERVER_URL=https://35-187-80-26.sslip.io
# ...or a tunnel to local dev (see "Which origin" below).
npx cap add ios
npx cap sync ios
npx cap open ios        # then run on a PHYSICAL device, not the simulator
```

**Physical device, not the simulator.** The simulator misreports storage
eviction, has no cellular radio for the rural-LTE criterion, and its camera is
synthetic — three of the five kill criteria are unanswerable on it.

### Which origin, and why it matters

Record which you used; the auth result is only meaningful against real https.

- **Production (`https://35-187-80-26.sslip.io`)** — real TLS, real cookies,
  real OAuth. This is what the auth criterion needs. It also means the spike is
  writing to production data: use a throwaway tenant and do not record field
  operations against a real farm.
- **Tunnel to local dev** — convenient, but cookie `Secure`/`SameSite` behaviour
  and OAuth redirect URIs differ. A session that survives here proves less.

---

## PREDICTED FAILURE — read before spending device time on auth

This was found by reading the codebase, not on a device, and it may block P2.3
outright.

Production sets `AUTH_CREDENTIALS_UI_HIDDEN=1` (`deploy/env.prod.example`), so
`/login` hides the email/password form. Real operators sign in with **Google** or
**Microsoft Entra** (`src/auth.ts` registers `AzureAD` and Google).

Two problems follow, in order of severity:

1. **Google refuses OAuth in embedded webviews.** Google returns
   `disallowed_useragent` for authorization requests from WKWebView-class
   embedded browsers, as an anti-phishing measure. `server.allowNavigation`
   permits the navigation at Capacitor's layer; it does not make Google accept
   it. If this fires, the standard fix is `@capacitor/browser`
   (`ASWebAuthenticationSession`) — but the session cookie then lands in that
   authentication session's cookie store, and **whether NextAuth's HttpOnly
   cookie reaches the WKWebView afterwards is exactly the thing to verify, not
   assume.**
2. Even if navigation succeeds, the redirect must return to the app's origin
   with the cookie intact.

**Do this first, before any other device work**, because it is cheap and it can
kill the auth criterion in ten minutes:

- [ ] Launch the shell, tap "Sign in with Google". Record verbatim what appears —
      the consent screen, or `disallowed_useragent`, or a blank view.
- [ ] Repeat with Microsoft. Entra is historically more permissive than Google
      here; if one works and the other does not, that is a finding, and it
      changes the recommendation rather than blocking it.
- [ ] If both fail: **stop and record it.** Do not immediately reach for
      `@capacitor/browser` — first write down what it would cost, because
      "sign-in needs a separate native auth flow" is a materially different
      product than "we wrapped the PWA".

The credentials route itself is still reachable (only the UI is hidden), so a
password sign-in can unblock the *rest* of the runbook. If you use it, label
every later result accordingly: **you tested a path production operators do not
use**, and the auth criterion remains unanswered.

---

## P2.3 — auth end to end

- [ ] Sign in (record which provider, and whether via webview or a native auth session).
- [ ] Confirm you land in a tenant, and that `/api/t/:slug` calls succeed —
      middleware gates those on a JWT `tenantSlug` claim, so a partial session
      shows up here first.
- [ ] Background the app. Wait **≥5 minutes**. Reopen.
- [ ] Record: still signed in? Silently re-authenticated? Bounced to `/login`?
- [ ] Force-quit. Relaunch. Record the same three outcomes.

Write exactly what happened, not "worked". "Session survived backgrounding but a
force-quit returned to `/login`" is a finding; "auth works" is not.

---

## P2.4 — the field loop, by hand

locations → a parcel → the map → record a field operation → attach a photo.

Note every place it reads as a website rather than an app. The bar is
specificity — **"the header bounces on scroll and the back gesture navigates the
wrong way" is a finding; "feels webby" is not.** Candidates worth looking for,
because each is separately fixable and none implies a rewrite:

- rubber-band overscroll on a fixed header
- the iOS back-swipe gesture doing browser-history navigation instead of app navigation
- text selection / callout menus on long-press where a native app would show none
- keyboard avoidance pushing the layout rather than scrolling it
- status-bar colour not matching the app shell
- tap highlight rectangles on `BottomTabBar` items
- pull-to-refresh triggering a webview reload and losing in-page state

For each: record it, and record whether it is fixable in the shell (a Capacitor
config flag or a CSS rule) or only by a rewrite. That distinction is what the
verdict turns on.

---

## Recording findings

Write into `docs/spikes/2026-08-18-capacitor-spike.md` **as you go, not at the
end.** §6's table is answered in the criteria's original wording. If a criterion
said "cold launch offline shows the shell" and you saw a failure screen, that is
a **NO** — do not restate it more loosely to make it passable.

An absent observation is fine and expected. An invented one destroys the spike's
only purpose.
