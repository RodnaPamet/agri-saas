# P6.4 — what an anonymous visitor is sent

First PR of #1813. The measurement is the argument, so it goes first.

## 404,506 bytes

The root layout serialises `getMessages()` into the RSC payload through
`NextIntlClientProvider`. Measured 2026-10-14:

| locale | full catalogue | needed by `/f/[handle]` | share |
|---|---|---|---|
| bg | 404,981 B | **475 B** | 0.12% |
| en | 250,923 B | 289 B | 0.12% |

93 namespaces, every one for a screen a stranger cannot reach, to render three
strings. On P6.5's budget of **LCP ≤2.5s over rural mobile data**, that payload
is the difference between the target being reachable and not — which is why
this came before the LCP item rather than after it.

## This is NOT "split the i18n catalogs", and I think the checklist is wrong

P6.4 says to split them. `NextIntlClientProvider` takes a `messages` **object**,
so passing a subset buys the same bytes without touching either file.

Splitting 93 namespaces across files would buy the same thing and cost the
pre-commit parity check, which today compares `bg.json` and `en.json`
key-for-key and prints `missing/orphan/drift/untranslated`. Across N files that
check has to reason about which file a key belongs in — the shape that lets a
key move between files while every per-file check still passes.

The split was a *means* to the slim payload. This is the end without the means.
Recorded rather than quietly substituted: if the split is wanted for another
reason, that reason is not this one.

## How a layout learns the request is public

It cannot see the pathname — a layout receives only `children`. The middleware
already knows, so it says so on the **request** headers, which is exactly the
bridge the CSP nonce uses (`csp-request-header-bridge` guards that pattern) and
the root layout already awaits `headers()`, so reading one more costs nothing.

Set only when **present**, and an absent header means the operator app. That is
the safe direction: a missing header ships the full catalogue, costing bytes,
where a wrongly-set one would strip copy from a real screen.

## "Public surface" is narrower than "public path"

`isPublicPath` is true for `/login`, `/register`, `/no-tenant`, `/tenants` and
`/invite/` — public *pages*, but part of the operator app and wanting its
shell. The public **surface** is the smaller idea: pages a stranger reaches
from a shared link or a printed QR code, which today is `/f` alone.

Matched at a segment boundary, so `/fx` does not inherit a decision about `/f`.
The failure direction here is mild — a page would get the full payload rather
than the slim one — but a rule that is right for one reason and wrong for
another is the kind that gets copied into the place where it matters.

## The namespace list is a claim, and raw keys are the failure

A public page reading an unlisted namespace renders `publicFarm.cropsTitle`
where «Култури» belongs. **next-intl does not throw** for a missing namespace
in a server component: the HTML is valid, the status is 200, and a reviewer
reading the diff sees a correct `getTranslations('somethingElse')` call. The
only observer is the visitor.

`tests/guards/public-surface-i18n-complete.test.ts` derives the namespaces the
public surface's files actually read and fails on an unlisted one — and checks
the other direction too, since a listed namespace no catalogue has is a typo
`publicSurfaceMessages` skips silently, leaving the page it was added for
rendering raw keys anyway.

Mutation-proved both ways: the page reading `farmTasks` fails one case, and a
`typoNamespace` in the list fails one case.

### The guard's honest limit

Its population is the public surface's own render tree — `src/app/f/**` plus
the root `not-found`/`error` pages a withdrawn handle reaches. It does **not**
follow imports, so a shared component three levels down calling
`useTranslations('x')` would not be seen.

That is a real gap, and it is why the namespace list should err **wide**:
adding a namespace costs bytes, omitting one costs a visitor the page's words.
A full import-graph walk is the stronger check and a larger piece of work;
stated here rather than implied.

## Deliberately not in this PR

The root layout also mounts six client components on a public page —
`ServiceWorkerRegistrar`, `WebVitalsReporter`, `ClientDataRetentionSweep`,
`Providers`, `InstallPrompt`, `NextIntlClientProvider`. A stranger viewing a
farm page installs the operator PWA service worker and runs a data-retention
sweep for data they do not have.

That is worth fixing and it is **not** folded in here, because `Providers`
mounts `ThemeProvider` and the page's CSS uses theme tokens — omitting it risks
the rendering. Bundling a rendering risk into a 400 KB byte win would make both
harder to review. It needs its own measurement and its own PR.
