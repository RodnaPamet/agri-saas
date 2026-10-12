# 2026-10-12 — the way out was gated on the condition it escapes

**Issue:** #1667 (ruling 3 of three). Part of #1600.

## Design

`ACCOUNT_TERMINATED` sets `suspendedAt` **and** `deletionRequestedAt`. P5.9's
check sits in `getSessionOrThrow`, which `getUserCtx` calls — so
`DELETE /api/account/deletion` answered `403 ACCOUNT_SUSPENDED` to exactly the
person entitled to stop the erasure, while agrent-ios's recovery screen (#282,
installed on the owner's phone) offered them the button.

Owner ruling: they may cancel. `getSessionOrThrow` and `getUserCtx` gained an
`allowSuspended` option, and that route is its one caller.

## This repo already wrote the rule

P5.5a, for slow mode:

> **The way OUT of slow mode must never sit on the default tier.** An
> unverified account throttled on the route that verifies it cannot escape, and
> the tighter the tier the worse it gets.

`tests/guards/slow-mode-escape-is-not-throttled.test.ts` pins that one. This is
the same shape with a different control, and
`tests/guards/suspension-escape-is-not-gated.test.ts` is its counterpart.

## The asymmetry is the subject

A suspended account may **stop** an erasure and may not **start** one. Both
verbs live in `src/app/api/account/deletion/route.ts` and only `DELETE` is
exempt, so a reasonable "hoist the ctx resolution out of the two handlers"
refactor would open `POST` silently. Hence the guard asserts there is exactly
**one** occurrence of `allowSuspended` in that file and that it falls after
`export const DELETE`, and the unit suite asserts `POST` still refuses.

## What cancelling does NOT do

It clears `deletionRequestedAt`. `suspendedAt` stays, so the person stops the
erasure and **remains locked out**. That is the honest outcome and it is why
the web `/suspended` page gained no cancel control here: a button that stops a
clock without restoring access needs wording of its own, and only the phone
has such a control today. Open on #1667.

## Files

| file | role |
|---|---|
| `src/lib/auth.ts` | `getSessionOrThrow({ allowSuspended })` |
| `src/app-layer/context.ts` | threaded through `getUserCtx`; the other three resolvers untouched |
| `src/app/api/account/deletion/route.ts` | the one caller, on DELETE |
| `tests/guards/suspension-escape-is-not-gated.test.ts` | NEW — count held at one |
| `tests/unit/terminated-account-can-cancel-erasure.test.ts` | NEW |
| `CLAUDE.md`, `src/lib/auth/suspension.ts` | "every authenticated request" is now "every one but one" |

## Decisions

- **An option that disables a security check needs its count held.** Those
  spread, and the honest form is one named exception whose second caller costs
  a visible line and a reason. The guard's allowlist reason has to name the
  action and why withholding it would be worse — "it is convenient" and "the
  route is read-only" are explicitly rejected, the latter because
  `offline/whoami` and the promotion image are reads and both stayed gated.

- **The exemption is narrow by construction, not by promise.** A valid session
  is still required (asserted: no session is still a 401), and
  `cancelAccountDeletion` clears one column on the **caller's own** row.
  Nothing widens what a suspended account can read.

- **Two claims went stale and were corrected in the same diff.** CLAUDE.md said
  `User.suspendedAt` is read on "EVERY authenticated request" and
  `suspension.ts`'s docblock said the same. Both now say "every one but one"
  and name it. The same section also still quoted the pre-#1668 statement
  wording, which was accurate for P5.4b and understated what P5.9 does.

- **Mutation-proved both ways**: removing `allowSuspended` fails 4, and adding
  it to `POST` as well fails 2 — the asymmetry test and the guard's
  exactly-one assertion.

- **`withApiErrorHandling` returns a response rather than throwing**, and I
  wrote `rejects.toMatchObject({ status: 401 })` first. "Received promise
  resolved instead of rejected" is the wrapper working, not the refusal
  missing. It also types its handler `(req, ctx)` even where the inner one
  ignores the second argument, which jest does not mind and `tsc` does.
