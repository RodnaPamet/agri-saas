# 2026-10-12 — a protection that was a side effect of a different control

**Issues:** #1671, #1667. Part of #1600.

## What happened, in order

1. **#1654** wired `ACCOUNT_TERMINATED` to `requestAccountDeletionOnTx` — the
   **self-service** helper — so a termination wrote exactly what a person asking
   to leave writes. `User` had `deletionRequestedAt` and `pseudonymisedAt` and
   no initiator column, so the two were indistinguishable in the data.
2. Its CLAUDE.md note recorded that a terminated person cannot cancel, *because
   they are suspended and the cancel route refuses a suspended account*. True at
   the time, and a property of a **different** control.
3. **#1667** (this session) found that the same refusal denied a person who had
   **requested** deletion and was later suspended the ability to change their
   mind — a real defect — and the owner ruled they may cancel.
4. That PR would have merged with **all ten required checks green** and taken
   the termination protection with it. Nothing asserted it, because nothing had
   to while the suspension check happened to cover it. Caught on review by
   `agrent backend-2`, whose conflation it was and who said so plainly.

`a-safety-argument-expires-silently`, with the premise owned by one session and
the change that voided it by another.

## The fix

`User.deletionRequestedBy: DeletionInitiator?` (`SELF | MODERATION`), nullable.
`SELF` may cancel even while suspended; `MODERATION` is refused with
`ACCOUNT_TERMINATED`.

The refusal lives in **`cancelAccountDeletion`**, not at the route. The previous
protection was a route behaviour, which is precisely why it evaporated; a
property of the erasure cannot be removed by changing who may reach an HTTP
surface. Any future cancel path inherits it.

## Files

| file | role |
|---|---|
| `prisma/schema/enums.prisma`, `auth.prisma` | the enum and the nullable column |
| `prisma/migrations/20261012120000_add_deletion_initiator/` | additive; no inverse needed |
| `src/app-layer/usecases/account-erasure.ts` | required `initiator` param; the refusal |
| `src/app-layer/usecases/moderation.ts` | `actOnNotice` passes `MODERATION` |
| `src/app/api/account/deletion/route.ts` | `allowSuspended`, now admitting SELF only |
| `src/app/api/auth/me/route.ts` | the 403 carries `erasesAt` only when cancellable |
| `src/lib/openapi/paths/account.paths.ts` | the 403 description, rewritten |
| `src/lib/auth.ts`, `src/app-layer/context.ts` | `allowSuspended` threaded |
| `tests/guards/suspension-escape-is-not-gated.test.ts` | the escape held at one call site |
| `tests/integration/{p5-6b-erasure,moderation-audit-chain}.test.ts` | the rule, executed |
| `tests/unit/terminated-account-can-cancel-erasure.test.ts` | the route matrix |

## Decisions

- **`initiator` is a REQUIRED parameter with no default.** A default makes the
  distinction optional at the one call site that must get it right, and the
  failure is silent: a termination recorded as `SELF` becomes cancellable.
  TypeScript refusing the call is the cheapest available reminder.

- **NULL reads as `SELF`, and that is the safe direction here** — not a general
  rule. Termination→erasure only shipped in #1654 and production holds no
  terminated accounts, so every pre-existing row is a self-service request.
  Reading NULL as `MODERATION` would have made every pending self-service
  deletion uncancellable on deploy day. Asserted, with a row forced to NULL.

- **A DISTINCT code.** `ACCOUNT_SUSPENDED` invites an appeal and an appeal would
  not restore anything, so the refusal is `ACCOUNT_TERMINATED` — already in the
  spec, so no baseline entry.

- **`/me`'s `erasesAt` is CONDITIONAL, and the unconditional version was the
  original defect returning.** The owner's ruling was "carry `erasesAt` when a
  deletion is pending". Taken literally, a terminated person would receive a
  date and an implied cancel the server refuses — which is the recovery screen
  offering an unhonoured action that `/me`'s own check was added to fix. Raised
  by backend-2 before it shipped; it is present only for a `SELF` erasure, and
  its presence is now the client's signal that the cancel will be honoured.

- **A mutation survived and produced the most useful assertion here.** Changing
  `actOnNotice` to record `SELF` left `moderation-audit-chain.test.ts` entirely
  green — the suite whose docblock claimed a terminated person cannot undo it,
  and which contains a case named *"revokes the sessions, which is what blocks
  the self-undo"*. Session revocation was never the protection. Two assertions
  added: the termination records `MODERATION`, and the subject's cancel is
  refused with the erasure still pending. A refused cancel that half-applied
  would look identical from the caller, so the row is asserted, not the return.

- **The claim in that docblock is corrected rather than deleted.** It is the
  clearest statement of the failure mode available, and the next reader is
  better served by seeing which sentence expired and why.
