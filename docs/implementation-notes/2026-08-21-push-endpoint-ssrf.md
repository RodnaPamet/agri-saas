# 2026-08-21 — the Web Push SSRF, and the guard it could not reuse (#696)

**Commit:** `see git log` fix(security): the shared SSRF guard classified hostnames as IPv6 addresses

## Design

`PushSubscription.endpoint` is client-supplied and reaches
`webpush.sendNotification` — a server-side request to a URL the client chose.
The repo already had an SSRF policy for the analogous automation webhook path,
so the fix looked like one line of reuse. It was not.

Two layers, both required, now shared by both consumers:

| layer | function | catches |
|---|---|---|
| structural | `checkWebhookUrl` / `checkPushEndpoint` | scheme, literal private IPs, blocked names, single-label hosts |
| resolved | `assertPublicAddress` | a public NAME that resolves into private space |

Enforced at two seams for push: the schema (structural only — `withValidatedBody`
calls `schema.parse`, which is synchronous) and the send path (both layers, and
the only seam that re-examines a row stored under an older policy).

## What `web-push@3.6.7` actually does — read, not assumed

- Its only validation is "endpoint is a non-empty string" (`web-push-lib.js:86-93`).
- **The scheme is discarded.** `url.parse` → hostname/port/path → always
  `https.request` (`:348-369`). So the `https:` pin narrows what can be
  *stored*; it changes nothing about what the library *does* — and the **port
  is attacker-chosen**, making this a port scanner, not just a host reacher.
- **No redirect following** (`:377`) — any non-2xx is an error.
- No socket timeout unless the caller passes one (`:222`).

## The guard could not be reused as it stood

| defect | measured |
|---|---|
| hostnames classified as IPv6 addresses | `isPrivateAddress('fcm.googleapis.com') → true`, via `startsWith('fc')` with no colon and no `net.isIP` check |
| v4-mapped v6 **hex** form evaded | `new URL('https://[::ffff:169.254.169.254]/').hostname` is `[::ffff:a9fe:a9fe]`; the `::ffff:` dotted branch never saw it |
| trailing-dot FQDN evaded both name checks | `metadata.google.internal.` — `endsWith('.internal')` false, Set lookup misses |

The first is not an SSRF, it is a false positive — and it was the dangerous one
for this work: reusing the guard verbatim would have blocked **every
Chrome/Chromium/Android subscription** while Firefox and Safari worked. It was
also already refusing any automation webhook on an `fc`/`fd` host, with a reason
naming a cause that is not true.

Severity of the other two, stated so they are not over-read: on the webhook path
the DNS re-check caught both (`lookup('[::ffff:a9fe:a9fe]')` throws ENOTFOUND;
the trailing-dot name resolves to 169.254.169.254). Holes in layer 1, not an
open SSRF. They matter because a synchronous consumer has no layer 2 beneath it.

## Decisions

- **`assertPublicAddress` finally exists.** The module docblock has named it
  since the guard was written; `git grep` returned exactly one hit — that
  docblock line. The DNS re-check lived as six inline lines inside
  `fireWebhook`, so a second consumer would have inherited only the weaker half.
  Extracting it upgraded it: `{ all: true }` (the inline version read ONE
  address, so a multi-A host passed if the first was public), a 2s bound
  (`dns.lookup` has none and this runs inside an HTTP request), a per-host cache
  (real endpoints concentrate on four hostnames), and refuse-on-resolve-failure.

- **A blocked endpoint is NEVER pruned.** `dead[]` feeds a hard `deleteMany`.
  `PushOptIn.tsx:46-49` renders a static "alerts on" span with no button once
  the BROWSER holds a subscription — the status comes from `PushManager`, not
  from our DB — and `public/sw.js` has no `pushsubscriptionchange` handler. So
  deleting the row is permanent, silent notification loss the operator cannot
  undo. Blocked endpoints are skipped and logged under a distinct
  `web-push.endpoint_blocked` event, never `send_failed` (whose only
  discriminator is `status`, where a block would arrive as `0` —
  indistinguishable from a network blip).

- **The removal schema stays looser than the create schema.** A DELETE makes no
  outbound request and can only remove the caller's own row. Applying the host
  rule there would strand a row written under an older policy — the send path
  never prunes it, so there would be no way to remove it at all.

- **What this does not close.** DNS rebinding: the address is checked, then the
  HTTP client resolves again. The 10s socket timeout bounds the window; closing
  it properly needs a pinned-IP agent, which is a different piece of work.

- **`sso-config.discoveryUrl` was deliberately NOT bundled**, though #696
  originally grouped them. `discoverOidc` uses `fetch`, which follows redirects
  by default — so a host check before the call is defeatable by a 302 into
  private space. Same-looking, materially harder, needs a redirect policy too.

## A process note worth keeping

Two of the mutation proofs for this change **passed at first because the
mutation silently failed to apply** — a `str.replace()` whose target had
shifted, with no assert. A mutation proof that does not verify the mutation
landed is the same failure class as `npx tsc | tail -2; echo $?` reporting
`tail`'s status: green, and measuring nothing. Every mutation here now asserts
its own application before the suite runs.
