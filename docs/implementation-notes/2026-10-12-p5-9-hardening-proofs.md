# 2026-10-12 — P5.9 hardening: two proofs, a counter, and a block that never enforced (#1600, #1664)

**Commit:** pending

## What #1600 asked for, and what was actually true

Three bullets. Checking each against the code first changed the work:

| #1600 says | reality |
|---|---|
| "a suspension takes effect within the window…, proven by a test that measures it" | **already met** — `p5-9-suspension-takes-effect.test.ts:91` is `it('MEASURES the window: resolves before, refuses after, nothing in between')`, from #1638 |
| "P5.2 adds `PUBLIC_MUTATION_LIMIT`; P5.9 proves the cap by exceeding it, and checks the per-subject counter P5.2 records" | the constant is `PUBLIC_NOTICE_LIMIT`; the cap proof was real work; **the per-subject counter did not exist** |
| "extends it to the person-level block's enforcement path" | real work — and writing it found that **the enforcement never worked** |

## The person-level block did not enforce (#1664)

`UserBlock`'s SELECT policy keys on `app.user_id`. The enforcement lives in
`requireParty`, inside `runInTenantContext` — which sets `app.tenant_id`,
`app.request_id` and `app.actor_user_id`, never `app.user_id`. So
`personBlockExists` and `amIBlockedByAnyOf` selected from an empty view and
returned `false` for every pair, always. Blocking somebody had no effect on any
thread path, and nothing errored.

Measured, with a positive control — same row, same helper, two contexts:

```
[probe] userContext   count = 1
[probe] tenantContext count = 0
```

And the fix proved load-bearing by removing it:

```
[proof] with arm = 1      [proof] without arm = 0      [proof] restored = 1
```

**Why two green suites missed it.** `person-block-is-silent.test.ts` mocks
Prisma, so its mock returns a block row when asked and it cannot express "the
policy hides this row". `p5-1-trust-safety-rls.test.ts` covers the table's
policies correctly, under `runInUserContext`. Both right about their own axis,
and neither covering the seam — `a-seam-is-a-new-collector`.

**The fix: a SELECT-only arm keyed on `app.actor_user_id`.** It admits exactly
the same two people in the other context, so it widens nothing. Writes stay
`app.user_id`-keyed because the social block routes are person-scoped.

Two alternatives rejected, both for reasons that would have been invisible later:

- **Read `UserBlock` through the privileged client.** `requireParty` runs inside
  a `$transaction`, so a global-client read takes a second pool connection while
  the first is held — #1191's P0.8 deadlock, with `PG_POOL_MAX` at 12.
- **Set `app.user_id` in `runInTenantContext`.** One line, and it would start
  admitting `ContentReport`'s reporter-read rows inside every tenant
  transaction. P5.2a's design depends on that arm NOT matching there.

## The per-subject count (#1600)

`PUBLIC_NOTICE_LIMIT`'s docblock justified not capping per-subject by saying
"P5.2 records a per-subject count without enforcing it, so a threshold can be
chosen from data". **Nothing computed such a count.** The capability had been
indexed for — `ContentReport.@@index([subjectKind, subjectId])`, commented "the
triage queue's two access paths" — and never built, so no threshold could have
been chosen from anything. The docblock is corrected in the same change.

Owner ruling: build it, **display only**. One `groupBy` scoped to the page's own
subjects (not one count per row, which D1 forbids; not a global tally, which is
unbounded), served by that index.

**`notice-score-is-shadow-only` grew a §4 to cover it**, and had to: §1-§3 match
a MODEL name, and the count is a computed field on a return type with no model
of its own, so a `sortBy(n => -n.subjectNoticeCount)` would have been invisible
to a guard whose whole purpose is stopping a number from ordering the triage
queue. A guard aimed one level off its target.

The distinction enforced is read-vs-order: a moderator seeing "5 notices about
this listing" is the point; report volume becoming the queue order is not,
because volume is the one signal a brigade can drive directly.

## The flood cap (#1600)

`expect(PUBLIC_NOTICE_LIMIT.maxAttempts).toBe(10)` asserts a constant holds its
own value — it passes if the preset is never applied, if the route forgot to
pass it, or if the limiter cannot reach that method, which is the failure #1643
shipped on a GET. So the test drives the real wrapper until refused and asserts
the count exactly: a route that fell back to the default tier refuses at 61, and
"it refuses eventually" would call that a pass.

Mutation-proved both ways — route drops the preset (1 failure), preset widened to
the default's value (2 failures).

## Files

| file | role |
|---|---|
| `prisma/migrations/20261012160000_user_block_select_in_tenant_context/` | the actor-keyed SELECT arm |
| `src/app-layer/usecases/moderation.ts` | `subjectNoticeCount`, display-only |
| `src/lib/security/rate-limit.ts` | the corrected docblock claim |
| `tests/integration/p5-2b-person-block-enforces.test.ts` | the context the enforcement runs in, with controls both ways |
| `tests/unit/public-notice-flood-cap.test.ts` | the cap proven by exceeding it |
| `tests/guards/notice-score-is-shadow-only.test.ts` | §4 — the count never orders or filters |

## A matcher that tripped on syntax, not its subject

§4's first threshold regex matched the operator in either direction. The mirror
form flagged `<span>{notice.subjectNoticeCount}</span>` — the `>` closing the tag
sits a few characters from the field — so the guard reported the one usage the
field exists FOR. Narrowed to field-then-operator only; an inverted comparison
(`5 <= n.count`) is now uncaught, which is the right trade, because a guard that
cries wolf on every display site is one somebody deletes.

## A suite-level failure with no failing assertion

The new integration suite's teardown deleted its Tenants and Users and tripped
`IMMUTABLE_AUDIT_LOG` (23001): those FKs are ON DELETE SET NULL, so the cascade
is an UPDATE on an append-only table. All 22 tests passed and the suite failed.
Worth recognising by shape — a suite-level failure with nothing red is nearly
always teardown. Once a row has been audited it cannot be cleaned up, by design,
so the suite now removes only its blocks and says why.
