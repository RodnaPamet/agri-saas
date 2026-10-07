# P3.6 — `POST /api/me/farms`: creating a farm

Part of [social] P3 (#1194).

## The scope changed before a line was written

The brief reads "`POST /api/me/farms` **and join requests**. A join is always an
owner-approved invite, never automatic." I had designed against that: a
`FarmJoinRequest` table, a command-split RLS policy set, a permanent-block
unique index, and an approval path minting an invite.

Three owner rulings on 2026-10-06 collapsed it:

- memberships are **invite-only**;
- owners and admins **are** the farm's proprietors and pay the subscription;
- owners/admins **sign up freely**.

Together those describe a flow with no join requests in it: a proprietor signs
up, creates the farm, and invites everyone else. So this route **creates a
farm**. No request model, no approval flow, no table. Asking a direct question
saved an entire table and four policies that nothing would have used.

The distinction that keeps it honest: the **creator's** own OWNER membership is
not a "join". Invite-only governs joining an *existing* farm. Creation delegates
to `createTenantWithOwner` in `tenant-lifecycle.ts`, already on
`ALLOWLISTED_MEMBERSHIP_SITES`, so neither the route nor the usecase touches
`tenantMembership` and the allowlist stays at eight sites — by construction, not
by review.

## Creation can never produce a DISPUTED claim, and the first version pretended it could

`fileIdentityClaim` originally caught `P2002` and inserted DISPUTED instead.
**That branch could never fire.** The partial unique index is
`(eikHash) WHERE status = 'VERIFIED'`, so a PENDING insert on an ЕИК another
farm holds VERIFIED violates nothing — PENDING rows pile up freely, which is the
entire point of the partiality. The integration test caught it: the row came
back PENDING where the test asserted DISPUTED.

The dead branch is gone and the comment now says where the dispute is raised
instead: at **verification** (P3.9), when a reviewer promotes a second claim and
the index refuses. A review console expecting creation to have marked disputes
would never see one, so this is a handoff, not a detail.

It also makes the enumeration property *unconditional*. There is no branch at
creation time that can differ by whether the ЕИК is taken — one code path, one
row shape, one response value. Uniformity by construction rather than by care,
and care is what rots.

## Six guard failures, all mine, all caught before pushing

Running the whole guard population first — the lesson from #1339, where I ran
only the guards I judged relevant and CI found a legacy-brand string. 676 suites
is one command.

| Guard | What it wanted |
| --- | --- |
| `social-routes-are-flag-gated` | `src/app/api/me/**` is classified SOCIAL. **This is the first route to make that set non-empty**, so the requirement bit here for the first time. Gated on `social.farm-registration`. |
| `no-server-authored-user-copy` | Prose thrown from a usecase reaches the iOS app and renders raw. Eight throws converted to machine-readable codes; the Bulgarian copy moved to the client where `messages/bg.json` lives. |
| `lookup-hash-call-sites-registered` | The new `eik`-kind hash write had to be registered, with the rotation hazard named. |
| `route-inventory-ledger` | Regenerated; +1 entry. |
| `openapi-paths-complete` | The undocumented baseline only shrinks, so documenting was mandatory rather than optional. New `me-farms.paths.ts`; baseline 247 → 246. |

The copy one is the most valuable: I had written hardcoded Bulgarian error
strings into a usecase, which no i18n guard walks. The fix is strictly better
than what I wrote — a code the client can translate, with the English beside it
as the fallback.

`assertFeatureEnabled` throws **404, not 403**, deliberately: a dark-launched
surface must not be discoverable. P3.8's wizard and any E2E driving it must
enable the flag first, because a flag that does not exist is off.

## Mutation proofs

| Mutation | Result |
| --- | --- |
| drop the ЕГН refusal | 1 failed — the ЕГН case |
| drop the checksum refusal | 1 failed — the invalid-ЕИК case |
| deterministic slug (no random suffix) | 1 failed — the same-name case |

Each kills exactly one test. The test fixtures use `isValidEik` / `looksLikeEgn`
as **oracles** rather than reimplementing the mod-11 checksum — a second copy in
a test can drift from `bg-identifiers.ts` and then the file asserts against its
own arithmetic, green while the product rejects every number it generates.

## Verification

```
tests/integration/farm-creation.test.ts                 9 passed
tests/guards + tests/guardrails (680 suites)         8593 passed
full tsc --noEmit (buildinfo deleted first)            exit 0
npm run lint                                           exit 0
```
