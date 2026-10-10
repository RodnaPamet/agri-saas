# P5.4a — the moderation console (#1595)

Two routes and four usecases. The interesting part is what the credential model
can and cannot say about who made a decision.

## `moderatorRef` had nothing to populate it from

#1553 DECISION 7 made it an opaque string rather than a `userId` FK, because
the credential is an API key with no `User` in scope and "accepting a
caller-supplied id would put an unverified name in an attribution field".

It did not say what *would* fill it, and checking found there was nothing:
`verifyPlatformApiKey(req)` returned **`void`**. Not even which key matched.

Nor can the credential model produce a person. `PLATFORM_ADMIN_API_KEY` is a
**single key** for every operator, plus `_PREVIOUS` for rotation. The existing
platform trail already reflects that: `PlatformAuditLog.actorType` defaults to
`"PLATFORM_ADMIN"` with a nullable `actorUserId`.

So the most precise attribution available is a **key generation**, and the gate
now reports it. The change is additive — 17 call sites, none used the return —
and carries no timing change, which is the part worth stating: both constant-
time comparisons have already run by that line, *deliberately*, because the
rotation comment requires that "timing equality across keys must hold".
Reporting which one matched reads a boolean that already exists.

`platform-key:current` narrows a compromise window to one side of a rotation
and is strictly more than a constant. **It is not a person**, and for a DSA
trail that is a real limit rather than a cosmetic one: a regulator asking who
decided something gets "somebody holding the key". #1599 (P5.8) owns the
credential model, and that issue now carries the dependency — the console
should not be relied on for that answer until it lands.

## `NotificationOutbox` cannot carry an Art 17 statement

It is tenant-scoped with a **non-nullable `tenantId`**, and a statement is
addressed to a person who may have no farm or several. Resolving one would be
inventing a tenant for a person-scoped obligation.

It does not need to. P5.1 shaped `StatementOfReasons.deliveredAt` as "NULL
until the push succeeds. The gap between `createdAt` and this is the Art 17
delivery lag, which is a thing a regulator can ask about." **The table is the
outbox** — a queued row is the queue, the `GET` is the drain view, and P5.4b
does the sending.

Surfacing the undelivered queue is part of the duty rather than an operational
nicety. A statement that never went out is a compliance failure, and what makes
it dangerous is that nothing else would show it: the action is recorded, the
notice reads ACTIONED, and the recipient simply never heard.

## The queue does not say who reported anything

`listNotices` returns `anonymous: boolean` and never `reporterUserId` — absent
from the shape, not merely unused, and the test asserts the serialised queue
does not contain the reporter's id anywhere.

A moderator decides on the CONTENT. Knowing who reported it invites deciding on
the reporter, and it is the same reasoning that makes Art 16 notices answerable
without the notifier being identifiable at all.

## Acting and answering are one transaction

A notice marked ACTIONED with no action row, or an action beside a notice still
RECEIVED, are both states a triage queue cannot tell from a crash — so neither
is reachable. `actionKind: NONE` moves the notice to REJECTED rather than
leaving it: "looked and did nothing" must be distinguishable from "never
looked", which an absent row cannot express.

The subject is denormalised from the notice, never from the request, so an
action cannot be recorded against content it was not about. The body accepts
neither `moderatorRef` nor a subject, and `.strip()` drops them.

## The guard that caught a real would-be-shipped bug

`public-routes-self-authenticate` failed within minutes of the routes existing:

> 2 route(s) verify their own credential but are refused at the Edge before the
> handler runs

Both routes verify `x-platform-admin-key`, and the Edge calls `getToken()`,
which understands only a NextAuth cookie — so a key request is 401ed before any
handler runs. They would have been **unreachable in production while looking
perfectly implemented**. That is the seventh instance of the shape in this
repo; the guard's own docblock lists six.

The fix is a `PUBLIC_PATH_PREFIXES` entry, `'/api/admin/moderation/'` with a
trailing slash because the children are the surface. Every `admin/*` platform
route is enumerated there individually for the same reason, and assertion B of
the same guard is what keeps the entry from being a hole: a route behind a
public prefix must authenticate itself.

## The sanitiser ratchet is back to 1

P5.1 raised `KNOWN_UNCOVERED` from 1 to 4 and moved the teeth onto a new
assertion — no entry may have a **live writer**. This PR gave
`ModerationAction` and `StatementOfReasons` their first writers and the
assertion fired on both, in sequence: first `ModerationAction`, then
`StatementOfReasons` on the next run.

Both are now in `RICH_TEXT_COVERAGE` naming `moderation.ts`, and the cap is 1 —
where it stood before P5.1. Across P5.1, P5.2a and P5.4a that mechanism drove
its own cleanup without anyone remembering to.

## Two test details worth recording

`globalPrisma` in an integration test is a bare `PrismaClient` with only the pg
adapter: **it carries none of the app's extensions**, so it neither encrypts on
write nor decrypts on read. Asserting on a `rationale` read through its models
returned `v1:…` exactly as a raw query does, and the assertion failed twice
before I stopped reaching for the ORM and decrypted explicitly.

The accident improved the test. It now asserts the envelope shape *and* the
sanitised plaintext underneath — an envelope alone would pass on text that was
never cleaned, and clean text alone would pass on a column stored in the open.
