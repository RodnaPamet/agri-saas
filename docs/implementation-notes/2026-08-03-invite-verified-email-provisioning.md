# 2026-08-03 — the invite link becomes optional

**Commit:** _(this change)_

## The report

An admin invited a user from `/admin/members`. The user signed in with
Microsoft Entra ID — successfully — and landed on **"You do not have
access to any workspace yet."**

Nothing was broken. The invite existed, the role was right, the sign-in
worked. The membership is created by `redeemInvite`, which is reachable
only through the `/invite/<token>` link: clicking it sets a 10-minute
HttpOnly cookie that the `jwt` callback reads. A user who goes straight
to the login page — which is what people do — carries no cookie, so
nothing redeems, and they hit `/no-tenant`.

The emailed link was a hard dependency on email delivery for a flow
whose whole purpose is granting access.

## Design

Add a second entry point to the same authorisation. The pending
`TenantInvite` is the standing grant; the token URL proves possession
of the link, and an IdP-verified login proves possession of the
address. Both are proofs of the same fact, so both should redeem.

```
Admin invites alice@corp.com as EDITOR
        │
        ├── PATH 1  Alice just signs in with Microsoft   ← new, the common case
        │     jwt callback → redeemPendingInvites(emailVerifiedByIdp: true)
        │                  → redeemPendingInvitesByEmail
        │                       finds pending invites for the verified address
        │                       claims each atomically, upserts membership
        │
        └── PATH 2  Alice clicks /invite/<token>          ← unchanged
              cookie → jwt callback → redeemInvite
                       token claim + email binding
                                    │
                    both converge → finalizeInviteRedemption
                                    (membership upsert + slug + audit)
```

The claim is the same `updateMany` with the same liveness predicates in
both paths, so a link-click racing a login cannot double-redeem — the
loser sees `count === 0` and skips.

Ported from `inflect-compliance`, which solved this first. The one
structural difference: that repo redeems in the `signIn` callback,
whereas here it must run in `jwt` — a first-time OAuth user's
`signIn` `user.id` is the identity-provider subject, not our `User.id`,
because the Prisma adapter creates the row only after `signIn` returns.
`redeemPendingInvites` already resolved the persisted id by email, so
the new path slots in behind that same resolution.

## Files

| File | Role |
|---|---|
| `src/app-layer/usecases/tenant-invites.ts` | Extract `finalizeInviteRedemption` from `redeemInvite`; add `redeemPendingInvitesByEmail`. |
| `src/lib/auth/invite-redemption.ts` | New `emailVerifiedByIdp` input; calls the email path when set; early-return now accounts for the token-free case. |
| `src/auth.ts` | jwt callback passes `emailVerifiedByIdp: account.provider !== 'credentials'`. |
| `tests/guardrails/no-auto-join.test.ts` | Allowlist reason rewritten to describe both entry points. |
| `messages/{en,bg}.json` | `noTenant.body` no longer tells users to follow a link they may not have; the SMTP-failure notice now says they can just sign in. |
| `CLAUDE.md`, `docs/epic-1-access-control.md` | Epic 1 claims corrected — "three paths" → "three modules, the first with two entry points". |

## Decisions

- **The gate is on VERIFIED email, expressed as "not credentials".**
  This is the security-critical line. Self-service registration lets
  anyone submit any address, and `AUTH_REQUIRE_EMAIL_VERIFICATION`
  **defaults to `"0"`**, so a credentials sign-in proves possession of a
  password, not of an address. Honouring an invite on that basis would
  hand a tenant to whoever guessed an invited email — a live concern,
  since #477 just made self-service registration safe to enable. The
  docblock records what would have to change to extend it: the
  condition is a verified email, so a caller would pass
  `AUTH_REQUIRE_EMAIL_VERIFICATION === '1' && user.emailVerified`,
  never a bare `true`.

- **This is not auto-join, and the tests are written to prove it.**
  GAP-01 was closed precisely because OAuth sign-in used to grant
  membership implicitly. The distinction is that an admin must have
  created an invite for that exact address and role: no invite ⇒ no
  membership. Four of the nine integration tests are negative — no
  invite, wrong address, revoked, expired — because that is the half
  that fails silently if it regresses.

- **A consumed invite is not a standing grant.** `acceptedAt` is set on
  first use, so a later sign-in finds nothing. This is why removing a
  member sticks: the test `does not resurrect a membership an admin
  deactivated` pins it, since the opposite behaviour (re-granting on
  every login) would quietly undo every removal.

- **The unit tests execute the gate rather than grepping for it.** A
  regression here is invisible — sign-in still works, it just also lets
  the wrong person in — so `emailVerifiedByIdp: false` asserting
  `not.toHaveBeenCalled()` is the check that matters, not a structural
  scan of `src/auth.ts`.

- **User-facing copy was part of the fix, not decoration.**
  `noTenant.body` said "follow the link in the invitation email" —
  precisely the wrong instruction, shown to precisely the user who
  didn't get one. It now says to sign in again with the same address.
