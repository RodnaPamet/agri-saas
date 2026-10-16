# The notifications SSE channel gets a runtime flag

The switch for `/api/notifications/stream` moves from a build-time
`NEXT_PUBLIC_NOTIFICATIONS_SSE` read in the client to a `notifications.sse`
`FeatureFlag` row read by the route per request. Default stays OFF.

Issue: #1982. Groundwork for P7.2 / P7.6 (#1198).

## The channel was unreachable, not off

Measured on production 2026-10-16. The `agrent-app` container, nine minutes
old, with a signed-in tab open:

```
  requests to /api/notifications          30   (15 requests x started+completed)
  requests to /api/notifications/stream    0
  request started / completed          15 / 15
```

Balanced started/completed is what makes the absence trustworthy: an open SSE
connection logs a start with no completion, so this is not an artefact of when
the logger writes.

The cause was not a flag set to `0`. `NEXT_PUBLIC_*` is inlined at `next
build`, and this variable appears in no Dockerfile `ARG` and no
`ghcr-publish.yml` build-arg — the Dockerfile passes exactly two of these
through (`NEXT_PUBLIC_MAPTILER_KEY:54-55`, `NEXT_PUBLIC_MAP_BASEMAP_STYLE:56-57`)
and the publish workflow passes exactly those two (`ghcr-publish.yml:222-223`).
So every image ever built baked it `undefined`, and the comment above it —
"future opt-in is one env-var flip" — was false for this deployment. Setting
the variable on the VM or in `/opt/agrent/.env` would have done nothing, which
is the first thing an operator would try and the kind of change that looks like
it worked, because the bell keeps updating either way.

Three places in the repo already described this as the thing not to do —
`src/lib/feature-flags.ts`, `prisma/schema/social.prisma` and CLAUDE.md all
cited `NEXT_PUBLIC_NOTIFICATIONS_SSE` as the *live* example of a flag that
cannot be flipped. All three now describe it as worked rather than outstanding.

## A client opt-in was never a feature flag

The route itself had no gate at all: authenticated, but ungated. So "off"
governed nothing except whether the UI chose to connect — anything else holding
a session cookie could stream. Moving the gate to the route is what makes the
flag mean something, and it is the mechanism P7's standing rules require
("every social route/page behind a RUNTIME feature flag, default OFF; never
`NEXT_PUBLIC_*`").

Default-off needed no extra work: a flag absent from the table resolves false,
so the channel stays dark until a row is inserted.

## 204, and why the client can now always ask

With the gate server-side the client stops deciding and simply attempts the
connection, guarded only by `typeof EventSource !== 'undefined'` for SSR and
jsdom.

A disabled channel answers **204**. `EventSource` reconnects on its own after a
network-level drop, so answering "off" in a way the browser reads as a blip
would produce a reconnect loop against a dead channel. Per the HTML spec's
EventSource processing model, a response that is not 200 with
`text/event-stream` makes the user agent fail the connection — fire `error`,
set `readyState` to CLOSED, and not reattempt. 204 rather than 403 because the
flag being off is not an authorization failure, and a 403 per page load would
log a stream of denials for a switch that is simply not on.

Nothing is closed by hand in `onerror`: `readyState` separates the two cases
for free (CLOSED means the browser gave up, CONNECTING means it is retrying a
real blip), and closing would throw away the automatic reconnect that is most
of the reason this channel is SSE.

**This half is spec-derived, not measured here.** jsdom does not implement
`EventSource`, so the suite asserts what the ROUTE does and cannot assert what
a browser does with it. A browser-level assertion wants an E2E spec and there
is no notification E2E spec yet.

## The E2E concern the old comment raised still holds

It said the client gate kept specs that wait on `networkidle` from hanging on a
long-lived stream. That property survives: `prisma/seed.ts` creates no
`FeatureFlag` rows, and suites that need one INSERT it explicitly (the
Lighthouse workflow does exactly that for `social.public-profile`). Nothing
enables `notifications.sse`, so every test environment gets a 204 and the
request completes.

## The guard was re-aimed, because it had been passing on the wrong thing

`notif-sse-streaming-wiring` asserted that the client reads
`env.NEXT_PUBLIC_NOTIFICATIONS_SSE === '1'`. That was true for months while the
channel was dead: the string it looked for was present, and the thing that
mattered — whether the flag could ever be set — was not expressible as a source
match on that file.

It now asserts the route resolves `notifications.sse` for `ctx.userId` (not
`null`: `cohorts` composes with `enabled` as AND, so a global resolve would
ignore cohort membership), that the gate precedes the bus subscription, and
that the client carries no second build-time gate. Comments are blanked with
`blankNonCode` first — the new docblocks name the retired variable to explain
it, so a raw-text search would find it in prose and report the opposite of the
truth.

Both directions are mutation-proved: reintroducing a client gate fails the
client assertion, and removing the route gate fails both route assertions.
