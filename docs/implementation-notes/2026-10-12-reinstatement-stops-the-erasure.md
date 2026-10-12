# 2026-10-12 — an upheld appeal deleted the farm anyway

**Issue:** #1667. Part of #1600. Regression introduced by #1671.

## What I broke

`ACCOUNT_TERMINATED` sets `deletionRequestedAt` as well as `suspendedAt`.
`liftSuspension` cleared only the second — it selected `{ id, suspendedAt }`
and updated `{ suspendedAt: null }`.

That was survivable until **#1671**, because the cancel route refused
*suspended* accounts: a reinstated person was no longer suspended, so the route
admitted them and they cleared the erasure themselves.

#1671 moved that refusal onto the **initiator** — `MODERATION` is refused
whatever the suspension state. That closed a self-undo, correctly, and
**removed the only path by which an upheld appeal could be completed**. A
reinstated person would have signed in, been unable to cancel, and been erased
at the end of the grace period regardless.

So "appeal upheld" meant nothing, and nothing in the product could undo it:
the only writes of `deletionRequestedAt: null` were the self-cancel — now
refused — and the sweep itself.

**Found by agrent-ios reviewing #1670, not by any test here.** It is the same
shape as the defect #1671 fixed, in the opposite direction: a capability that
existed only as a side effect of a different control, removed silently when
that control changed. Two instances in one chain, one in each direction, and
neither was asserted anywhere.

## The fix

`liftSuspension` stops a `MODERATION` erasure in the **same update** as the
reinstatement. The authority that made the decision undoes it: "the subject may
not undo a termination" stays true, and "nobody can" was never the ruling —
`liftSuspension` is the reversal verb.

A **`SELF`** erasure is left alone. Lifting a suspension says the suspension
was wrong, not that the person changed their mind about leaving; cancelling it
for them would overrule a decision that was theirs — and they can still cancel
it themselves, since a `SELF` erasure is admitted even while suspended.

## Decisions

- **One `user.update`, not two statements.** An account un-suspended with its
  erasure still scheduled is precisely the state this fixes, and a second
  statement could leave it on a partial failure.

- **`erasureStopped` is REPORTED, not silent.** It is on the result and in the
  `PlatformAuditLog` entry: "we lifted the suspension" and "we lifted it and
  cancelled the deletion" are different facts for an operator reading an appeal
  outcome, and the chain is where that is answerable afterwards.

- **The deletion-pending cache is dropped too, and only when something was
  stopped.** Otherwise `/me` keeps reporting a `deletion` that no longer exists
  for the rest of the TTL — and the phone offers a cancel for it, which is the
  promise-then-refuse shape this whole chain has been about. Mutation-proved in
  both directions: no drop fails one test, an unconditional drop fails another.

- **This also closes agrent-ios's phone concern without a contract change.**
  They noted that once a suspension is lifted, `/me` answers 200 with
  `user.deletion` set and nothing says who started it, so the installed app
  opens the recovery screen and the cancel is refused. After this fix a
  `MODERATION` erasure cannot coexist with an unsuspended account — `actOnNotice`
  is the only writer of one and `liftSuspension` is the only clearer of
  `suspendedAt` — so the 200-with-uncancellable-deletion state is unreachable.
  No `cancellable: false` field is needed.

## Two process notes, because both cost time

- **A `str.replace` with no assertion is a silent no-op.** Three edits in this
  work matched nothing and reported success: two `mockReset` insertions and a
  mock declaration. The failure surfaced later as `ReferenceError`, in a
  different file, after a passing run. Every scripted edit here now asserts its
  match count — the `empty-substitution-destroys-the-target` family, one step
  milder.

- **A branch cut from `main` does not have the sibling PR's symbols.** I added
  a `moderationActionCreate.mockReset()` referencing a mock that exists only on
  #1674's branch, and 15 tests failed at once. Worth stating because the two
  branches edit the same test file and the merge will need both resets.
