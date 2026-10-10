# P5.2a — notice intake (#1593)

Two routes and a table. The interesting part is that **three of the obvious
shapes are wrong**, and two of them fail silently, so this note is mostly about
those.

## The route path in the issue could not have worked

I filed #1593 saying the report routes would be `POST`/`GET
/api/t/[slug]/reports`. A tenant route runs `runInTenantContext`, which sets
`app.tenant_id` + `app.actor_user_id` and deliberately **not** `app.user_id`.
`content_report_reporter_read` matches on `app.user_id`. So under a tenant
context the arm matches nothing and "my reports" returns **zero rows with no
error** — which is what a person who has filed nothing also sees.

That is the exact fail-closed-but-silent shape P5.1's own migration warns
about, and I walked into it one issue later. Caught by reading
`/api/me/news-preferences` while looking for a route template, not by a test.

`/api/social/` over `/api/me/` because `isOperatorBlockedPersonPath`
(`guard.ts:409`) covers exactly `/api/social/` and `/social/`, so these get the
operator-persona refusal. And `getUserCtx` over bare `auth()`, because that
helper also refuses an `iflk_` API key presented as a person credential and an
MFA-pending session. `/api/me/news-preferences` is still the only other route
in the product using it.

## The read and the write deliberately run in different contexts

It reads as an inconsistency in `usecases/trust-safety.ts` and it is the shape
of P5.1's RLS:

| | runner | why |
|---|---|---|
| `listOwnReports` | `runInUserContext` | the policy arm needs `app.user_id`, which only that runner sets |
| `fileNotice` | privileged client | there is deliberately no `app_user` INSERT arm |

The consequence worth stating: **nothing may route a client value into
`reporterUserId`**. The anonymous path writes NULL, the signed-in path writes
`ctx.userId`, and there is no third case. `FileReportSchema.strip()` drops a
client-supplied one rather than rejecting it, so a caller can neither attribute
a notice to someone else nor learn from an error that the field exists.

`listOwnReports` also has **no `where` on `reporterUserId`** — the policy
filters. A `where` would make the isolation test pass with the policy dropped,
which is the one thing it exists to catch. Mutation-proved: swapping
`runInUserContext` for the privileged client turns exactly the two isolation
tests red.

## The snapshot moved off `ContentReport`, and retention is the reason

The owner chose "snapshot column". The substance holds — evidence is captured
server-side at report time — but the column would have been **reporter-readable**,
because the arm is ROW-level.

Mostly harmless: you can only report what you could see. Not harmless for
retention: a reporter filing against a private message would keep a durable,
decryptable copy *after its author deleted it*. That is a new capability, not a
receipt. So `ReportSnapshot` denies `app_user` outright, following the rule
DECISION 3 already set — content a reporter must not retain does not live where
the reporter arm can reach it.

Capture is **best effort and its failure is recorded, not thrown**. A notice
whose evidence could not be captured is still a notice the operator owes an
answer to, so losing it because the listing was deleted half a second earlier
would be the wrong trade. `captureError` distinguishes `SUBJECT_NOT_FOUND` from
`SUBJECT_KIND_NOT_CAPTURABLE` (`PROFILE` has no surface until P6), because
"nothing to capture" and "nobody implemented this" must not read the same.

## The response is an enumeration oracle if you let it be

`SUBJECT_NOT_FOUND` goes to the snapshot, never to the notifier. A notice form
that distinguished a real listing id from a made-up one would let an
unauthenticated caller enumerate ids by filing notices.
`tests/unit/trust-safety-routes.test.ts` pins the response body to exactly
`{id, status}` and greps it for leakage, because this is the property a
well-meaning change breaks — surfacing `captureError` "so the client can show a
better message".

## FLAG_EXEMPT keys are file paths, and the public route is not in that list

Both reporting routes are unflagged, and it is one duty rather than two
judgement calls: a flag defaulting OFF means an Art 16 obligation is unmet
until someone remembers to flip it.

I wrote URL-shaped keys first. The guard checks entries against `routeFiles()`
and against declared social roots, so a URL key is an exemption for a path the
population never selects — cover that protects nothing and hides that the rule
was never applied. Keys are repo-relative file paths under
`src/app/api/social/`.

The public route has **no `social` segment**, so that guard's population never
selects it and an entry there would be the same stale cover. Its
unauthenticated nature is exempted where it IS checked:
`public-routes-self-authenticate`, whose direction B requires every route
behind a public prefix to authenticate itself.

## `PUBLIC_NOTICE_LIMIT` is tuning, not a new control

Recorded because I twice claimed otherwise (see the P5.1 note and #1602).
`withApiErrorHandling` already defaults every mutation to `API_MUTATION_LIMIT`
(60/min) keyed on `(IP, userId)`, with the userId NULL for an anonymous caller.
So the endpoint was never unprotected.

10/min rather than 60 because the shapes differ: 60 is sized for a person
filling a form in a tab, and the harm here is a flood burying real notices in a
queue whose handling time is regulator-visible. Not lower, because
carrier-grade NAT puts a village behind one IPv4 — `PUBLIC_READ_LIMIT`'s own
docblock reasons about this for exactly this user base — and a genuine burst of
notices about one bad listing is what a real incident looks like.

Per-subject capping is **recorded but not enforced**: it is the control that
would actually catch brigading, and it has the wrong failure mode, letting the
first few notices suppress later legitimate ones about the same content.

## The self-expiring ratchet fired, one PR after it was written

P5.1 put `ContentReport` in `KNOWN_UNCOVERED` in
`sanitize-rich-text-coverage`, raised that cap from 1 to 4, and moved the teeth
onto a new assertion: no `KNOWN_UNCOVERED` entry may have a **live writer**.

This PR made `prisma.contentReport.create` a live writer, and the assertion
went red with `["ContentReport", "EvidenceReview"]` against an expected length
of 1. `ContentReport` is now in `RICH_TEXT_COVERAGE` naming
`usecases/trust-safety.ts`, and the cap is lowered to 3 rather than left at 4 —
slack a later regression can spend is what a ratchet exists to refuse.

That mechanism working on its first real test is the only evidence this kind of
design ever gets, so it is worth writing down.
