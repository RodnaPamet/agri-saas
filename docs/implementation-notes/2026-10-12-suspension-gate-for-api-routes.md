# 2026-10-12 — the suspension check had one caller

**Issue:** #1652 (part of #1600)

## Design

P5.9 put `isAccountSuspended` in `getSessionOrThrow`, and CLAUDE.md describes
that as "the Node choke point — all three ctx resolvers call it". Both halves
are true. Neither is the same claim as *every authenticated request*, which is
what the sentence invites a reader to conclude.

**Ten route files resolved a session with `await auth()` directly**, so
`isAccountSuspended` had exactly one caller. A suspended account could:

- **accept an invite and join a second farm**, carrying on there under a fresh
  membership — four routes, both invite POSTs and both `accept-redirect`s;
- **rotate its own password**;
- accept terms, read its own identity, read a promotion image;
- and be handed `deletion` by `/api/auth/me` — the case agrent-ios reported,
  from the doc rather than the code: a terminated person signs in, is shown
  «Възстанови профила», and the cancel is refused 403 by the route that does
  check. A recovery screen offering an action the server would never honour.

`src/lib/auth/session-gate.ts` is the door, in two functions, and
`tests/guards/api-routes-resolve-sessions-through-the-gate.test.ts` holds the
raw-`auth()` count at zero with the denominator printed.

## Why two functions rather than one `getAuthenticatedSession()`

The issue proposed one helper that throws for both refusals. That is the wrong
shape here, and the reason is a contract rather than a preference: these ten
routes answer an absent session in **four** different ways —
`{ error: 'Unauthorized' }`, `{ error: 'unauthenticated' }`,
`{ error: { code: 'UNAUTHENTICATED', … } }`, and a 302 to `/login` carrying a
`callbackUrl`. Those are published, with installed clients behind them.
Collapsing four into one would be a breaking change riding along inside a
security fix.

So both functions return the session **unchanged, `null` included**, and every
caller keeps its unauthenticated branch verbatim. The only thing they add is the
suspension verdict:

| | |
|---|---|
| `authRefusingSuspended()` | throws `ACCOUNT_SUSPENDED`. For a route inside `withApiErrorHandling`. |
| `authWithSuspension()` | returns the verdict. For a route that must not throw. |

The second exists for the two `accept-redirect` handlers: bare `GET` exports a
**browser** navigates to, where a thrown JSON 403 is rendered as raw JSON. They
redirect to `/invite/<token>?error=ACCOUNT_SUSPENDED` instead — a stable CODE,
not a sentence, because those routes' own `catch` puts `err.message` in that
parameter and `no-server-authored-user-copy` holds thrown prose on a downward
ratchet.

## Owner rulings

- **The MFA challenge-verify route stays on the raw `auth()`.** It is part of
  SIGN-IN, so a refusal there surfaces as a failure at the code entry and reads
  as "your code is wrong" rather than "your account is suspended". Better to let
  the challenge succeed and refuse at the first real request, which carries the
  sentence that explains it.
- **Invite acceptance is refused and the invite STAYS PENDING.** It remains
  valid for after a lift. No inviter notification — that would disclose a
  moderation state to a third party, and is filed separately (#1656) rather
  than decided inside this change.

## `/api/auth/me` is the tenth route and is NOT migrated

The issue says it is "fixed in #1619's branch". When this started that was
false: #1619 was open, no such branch existed on the remote, and main's route
used a raw `auth()`. It became true mid-change — **#1654 landed it from the
parallel session**, refusing INLINE off the `User` row the route already
queries.

That is cheaper than the gate for this one route: the row is being fetched
anyway, so reading `suspendedAt` from it costs nothing where
`authRefusingSuspended` adds a lookup. So my version was reverted to theirs, and
the route sits in the guard's allowlist. **Nine routes migrated, not ten.**

## Files

| file | role |
|---|---|
| `src/lib/auth/session-gate.ts` | NEW — the two doors |
| `src/app/api/auth/{accept-terms,change-password}/route.ts` | migrated |
| `src/app/api/{offline/whoami,promotions/[id]/image}/route.ts` | migrated |
| `src/app/api/invites/[token]/route.ts` | POST refuses; GET preview proceeds |
| `src/app/api/org/invite/[token]/route.ts` | same |
| `src/app/api/{invites,org/invite}/[token]/accept-redirect/route.ts` | redirect with the code, before redeeming |
| `src/app/api/t/[tenantSlug]/security/mfa/challenge/verify/route.ts` | annotated as the deliberate exemption |
| `tests/guards/api-routes-resolve-sessions-through-the-gate.test.ts` | NEW — count at zero, kinds checked |
| `tests/unit/{session-gate,suspension-gate-covers-the-invite-routes}.test.ts` | NEW |
| `tests/unit/accept-terms-route.test.ts` | its prisma mock predated the new read |

## Decisions

- **The allowlist records a KIND, and the kind is checked.** An entry is
  `selfChecks: true` (the route refuses by another mechanism) or `false` (a
  deliberate carve-out), and the guard asserts the source names
  `ACCOUNT_SUSPENDED` **iff** `selfChecks`. Without that, "it is covered another
  way" is a sentence that stays green after the other way is deleted. Proved
  both directions: flipping `/api/auth/me` to `false` fails, and stripping its
  inline `codedForbidden` fails.

- **The invite tests assert `redeemInvite` was NOT CALLED**, not merely that the
  response was a refusal. That is the owner's ruling made checkable: a route
  that redeemed and then threw would satisfy a status-only test while burning a
  single-use token — the person loses the invite and gains nothing. Mutation
  proof: moving the suspension branch to after the redeem fails exactly that
  assertion and nothing else.

- **The route tests run the REAL gate**, mocking `@/auth` and
  `@/lib/auth/suspension` instead. #1652 is about WIRING — a check that existed
  and worked, reached by one caller out of ten — and a test that mocks the door
  proves the door opens, which was never in doubt. Reverting one route to
  `auth()` turns three of them red.

- **The invite PREVIEW halves proceed for a suspended account**, asserted rather
  than left implicit, because it is the line a later reader is most likely to
  tighten. The ruling was about acceptance; a preview is a read of an invite the
  person was sent, already enumeration-safe.

- **The guard prints what it does NOT cover**: 19 non-API files under `src/app`
  call `auth()`. Server components are out of scope here, and a scope without a
  number beside it is a blind spot — filed as #1657.

- **One pre-existing test mock had to change, and the failure mode is the good
  one.** `accept-terms-route.test.ts` mocked `prisma.user.updateMany` only.
  `isAccountSuspended` fails CLOSED on a lookup error — correct in production —
  so a mock missing `findUnique` turned every test in the file into a 403.
  Loud, which is how it was found.

- **A stale generated Prisma client, not a type error.** `tsc` failed on
  `PlatformAuditAction` members that #1654's migration adds; the shared
  `.prisma` client belongs to whichever checkout ran `generate` last. 26,504
  tests passed while `tsc` exited 2 — which is the whole argument for gating on
  the exit code rather than a grep, and for running both.
