# 2026-10-11 — moderation decisions in the platform chain (#1619), and termination that finalises

**Commit:** pending

## Design

Three changes that are one change, because all three touch `actOnNotice`.

**1. The chain append.** `actOnNotice` and `queueStatement` write
`MODERATION_ACTION_RECORDED` / `MODERATION_STATEMENT_QUEUED` into
`PlatformAuditLog` under scope `moderation`, after the transaction commits,
inside a try/catch that swallows.

**2. `ACCOUNT_TERMINATED` finalises.** Inside the same transaction, a
termination now calls `requestAccountDeletionOnTx(tx, suspendUserId)` alongside
the suspension it already performed. The Art 17 statement says "we closed your
account"; until now that was true of access and false of the data.

**3. `GET /api/auth/me` reports a pending deletion — and refuses a suspended
account.** The field at the native client's request; the refusal because
shipping the field without it creates a recovery screen the server will not
honour.

## Files

| file | role |
|---|---|
| `prisma/schema/audit.prisma` | two `PlatformAuditAction` values |
| `prisma/migrations/20261012090000_moderation_audit_verbs/migration.sql` | `ADD VALUE IF NOT EXISTS` ×2 |
| `src/app-layer/usecases/moderation.ts` | the appends; the TERMINATED → erasure call |
| `src/app-layer/usecases/account-erasure.ts` | `requestAccountDeletionOnTx(tx, userId)` |
| `src/app/api/auth/me/route.ts` | `deletion` field; suspension refusal |
| `tests/integration/moderation-audit-chain.test.ts` | chain + TERMINATED behaviour |
| `tests/unit/auth-me-deletion-pending.test.ts` | the field, and the refusal |

## Decisions

- **Best-effort, and the ruling's named mechanism was wrong for this call
  site.** The owner's answer was "best-effort — via `afterCommit`", which is the
  house pattern. But `afterCommit` only defers when a scope is open, and scopes
  are opened by the `db-context.ts` helpers rather than by a bare
  `prisma.$transaction` — which is what `actOnNotice` uses. It therefore fired
  `void runEffect(...)` un-awaited and the test saw zero rows. A directly
  awaited try/catch after the transaction has the same semantics the ruling
  asked for. The mechanism was the implementation detail; the best-effort
  property was the ruling.
- **Two verbs rather than one entry with a `statementQueued` field.** Art 17
  makes deciding and explaining two obligations. An action with no statement is
  then visible in the chain rather than inferred from an absence.
- **Neither entry carries the rationale or the body.** `detailsJson` is not an
  encrypted column. The chain records `hasRationale: boolean`; the text stays on
  the encrypted column it belongs to. The statement body additionally gets
  REPLACED at send time by P5.4b, so a copy in the chain would be a draft
  presented as final.
- **`ACCOUNT_SUSPENDED` must NOT queue an erasure.** #1635 was an outcome
  recorded and announced but never performed; a suspension that silently
  performed MORE than it announced is the same defect inverted. Asserted
  explicitly, not left to the absence of a call.
- **The safety argument for wiring a moderation outcome to a self-service path
  is that the person cannot undo it** — they are suspended, so the cancel route
  refuses them. Which is exactly why the `/me` hole mattered.

## The hole the native client found, and the claim of mine that was wrong

`agrent-ios` read the P5.9 note in CLAUDE.md against this route and reported
that `/api/auth/me` authenticates with `auth()`, not `getSessionOrThrow`, so
P5.9's suspension check — whose only caller was `getSessionOrThrow` — never ran
there. Verified: **ten route files** resolve a session with a bare `await
auth()`.

My P5.9 section said `getSessionOrThrow` was "the Node choke point". True of the
ctx resolvers, and it invited the reader to conclude "every authenticated
request", which I then relied on in this change's own safety argument. The
consequence they described was specific: a TERMINATED person is suspended AND
erasure-pending, so they would sign in, be handed `deletion`, be shown
«Възстанови профила», and have the cancel refused — a recovery screen offering
an action the server would never honour.

`/me` is fixed here because the field and the hole ship together. The other nine
are **#1652**, with the guard that holds the count at zero; `change-password`
and the invite-acceptance pair are the ones that matter (a suspended account
could rotate its credential, or join a second farm).

## Three gates each rejected a version of this, and each was right

Worth recording together, because all three failures pointed at the same
instinct — "make the local change" — and in every case the repo already had the
better answer.

1. **The query count.** My first fix called `isAccountSuspended`, which added a
   second query and reddened `auth-me-avatar-url.test.ts`. That test pins this
   launch request at ONE query and its docblock predicts the failure in general
   terms: *"a later 'let me just check whether the object is really there' would
   add a query and fail here."* Reading `suspendedAt` off the existing
   `findUnique` is better on its own terms — no round trip, and authoritative
   rather than up to 30s stale behind the suspension cache.

2. **The response shape.** My second version returned a bare `{ error:
   'ACCOUNT_SUSPENDED' }`, matching this route's own 401. The #1228
   breaking-change gate scored **38 breaking entries** against the base, led by
   `"error.code" was removed; a client reading it gets undefined` — the bare
   form had REPLACED the documented envelope on this route's 403. The fix is to
   throw the same `codedForbidden('ACCOUNT_SUSPENDED', …)` `getSessionOrThrow`
   throws: the contract is untouched, and a client needs one decoder path for
   suspension rather than a special case for `/me`. Note the route's 401 is
   still bare and still documented as the envelope — pre-existing, out of scope
   here, and a reason not to reason from "what this route already does".

3. **The timestamp format.** `requestedAt` / `erasesAt` went in as bare
   `z.string()`, and #1391's guard failed it: *"2 of 148 response-side
   timestamps are typed without a `format`"*. `.datetime()` costs nothing —
   `format` is none of the six classes the breaking scorer reads, and these
   schemas are registration-only — and a generated client gets a date instead
   of an opaque string.

A fourth, smaller one on the test side: silencing `@/lib/observability/logger`
with a whole-module double removed `extractErrorMeta`, which
`withApiErrorHandling`'s error path calls to shape a thrown refusal — so the
suspension cases died with `extractErrorMeta is not a function` rather than
asserting a 403. The repo's partial-barrel-mock trap exactly; the mock spreads
`requireActual` now.

`count-the-routes-a-gate-covers` is the lesson and this is the second time in
P5 it has applied. The gate was named correctly and the denominator was never
printed — and a doc stating the gate was read by someone who then checked the
population, which is the only reason it was found at all.

## Why the `/me` field is on `/me`

The iOS peer's reasoning, which beat mine. I proposed `/api/account/profile`;
they replied that the phone reads `/api/auth/me` right after every sign-in,
before the first screen is shown, and never reads `/api/account/profile`. The
read guaranteed at the moment the recovery screen needs it beats the one that is
semantically tidier. `erasesAt` is derived from `DELETION_GRACE_DAYS` so the
date shown and the date the data goes cannot disagree, and the test asserts the
arithmetic rather than a literal 30.

They also caught that #1597's decision record said "recovery is by signing in,
which cancels the deletion", contradicting the explicit `DELETE` route I built.
That text was mine, quoted from the option wording; corrected on the issue
rather than edited silently.
