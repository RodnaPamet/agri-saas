# P5.1 — trust & safety models (#1553)

Four tenantless tables, schema only. The interesting part is not the columns;
it is that **one policy arm constrains what may ever be added to one of the
tables**, and that two pairs of near-identical things are keyed differently.

## The arm, and the constraint it creates

`ContentReport` gets a fourth policy arm on the owner's decision of
2026-10-10:

```sql
CREATE POLICY content_report_reporter_read ON "ContentReport"
    FOR SELECT
    USING ("reporterUserId" = current_setting('app.user_id', true)::text);
```

Without it, DSA Art 16 acknowledgement has to happen at submit time from the
platform side and "my reports" is impossible without a second read path. With
it, it is one index lookup.

**Postgres RLS is ROW-level, not column-level.** The arm therefore exposes
every column of the reporter's own row — now, and every column added later.
It is safe only because the moderation internals live on the other two tables.
Had the decision, the rationale, `moderatorRef` and the action history lived on
`ContentReport`, this arm would have leaked all of it, and the right answer
would have been a separate receipt projection instead.

So the three-table split stopped being a tidiness choice.
`tests/guards/content-report-columns-are-reporter-safe.test.ts` makes the
consequence visible: a new column needs a written note saying why a reporter
may read it, and if that sentence cannot be written, the column belongs on
`ModerationAction`. The guard also asserts the *premise* — that
`moderatorRef`, `rationale`, `actionKind` and `bodyRendered` are NOT on this
table and ARE on the ones that deny `app_user` — because a note requirement
alone would still be satisfiable by writing a note about a column that should
never have been there.

`status` is the one entry worth arguing, and it is deliberate: it reveals that
a notice was TRIAGED, ACTIONED or REJECTED, which is the outcome Art 16
entitles the reporter to and the reason the arm was wanted at all.

## Two pairs that look alike and are keyed differently

**`app.user_id` vs `app.actor_user_id`.** Two variables, two runners, and
picking the wrong one fails silently — the unset one yields NULL and the arm
matches nothing, so a block stops refusing rather than erroring.

| runner | sets | scope |
|---|---|---|
| `runInUserContext` | `app.user_id`, no tenant | a PERSON |
| `runInTenantContext` | `app.tenant_id` + `app.actor_user_id` | a person AT a tenant |

`ExchangeBlock` uses `app.actor_user_id` because the exchange runs in a tenant
context. `UserBlock` and `ContentReport` use `app.user_id` because a social
block and a notice have no tenant. The tables look alike; the variable is not
interchangeable.

**`UserSession`'s one-policy rule vs `ExchangeBlock`'s split.** The repo has
two established and opposite RLS patterns, each correct against a different
threat, and `UserSession`'s migration explicitly forbids what this one does:

> Splitting this into a read policy plus an insert policy would let an
> `app_user`-bound session UPDATE a null-tenant row to any tenantId.

That threat is about rewriting `tenantId`. `UserBlock` has no `tenantId` to
rewrite, so it does not apply — and the DELETE threat does: a single `USING`
clause governs DELETE as well as SELECT, and the blocked party must be able to
SELECT the row that refuses them. So the arms are split, and the UPDATE arm
carries an explicit `WITH CHECK` so the implicit `WITH CHECK (true)` that
rule warns about cannot arise.

## A refused UPDATE does not raise. A refused INSERT does.

Written down because the first version of the integration test asserted the
wrong one and failed:

- **INSERT** — a `WITH CHECK` violation is an error: `42501`.
- **UPDATE / DELETE** — with no permissive policy for the command, the rows to
  change are selected by a USING clause that is effectively false. The
  statement matches ZERO rows and returns normally.

`.rejects.toThrow()` on the reporter's UPDATE resolved to `0`. An expectation
of a thrown error there would have been a guard that could only ever be
satisfied by changing Postgres.

Hence the suite's shape: every negative asserts a row COUNT or a raised code,
never that a call returned; and every positive asserts a NON-ZERO count,
because a silently-unset `app.user_id` also produces zero and would make every
negative pass for the wrong reason.

## Why the platform-only guard checks set EQUALITY

`PLATFORM_ONLY_RLS_MODELS` in `tests/guardrails/rls-coverage.test.ts` maps each
table to the EXACT set of policies it may carry, and the test compares sets
rather than checking containment.

These tables are protected by the **absence** of a permissive policy per
command, not by the presence of a restrictive one — because `ALTER DEFAULT
PRIVILEGES` (migration `20260323180000`) grants `app_user`
SELECT/INSERT/UPDATE/DELETE on every new table in `public` automatically. A
tenantless table is reachable by a tenant session the moment it exists, and RLS
is the only refusal.

A containment check cannot see the regression that matters: adding a permissive
`app_user` arm leaves every expected policy in place and passes. Equality
fails.

## No foreign keys to `User`

Every person column is a plain `String`, following `ExchangeBlock`. An FK would
force an `onDelete` rule, and what happens to a report when its reporter
erases their account is the open GDPR question in P5.6
(delete-by-pseudonymisation) — not something to settle by picking a cascade
here. `Cascade` in particular would destroy the moderation record of a resolved
case, which is the opposite of what a DSA audit trail is for.

## One premise of DECISION 5 was not true

DECISION 5 — an anonymous notice stores no identifier — is justified by abuse
being handled at the Edge instead. Checked while building:
`src/lib/security/rate-limit.ts` has exactly ONE public limiter,
`PUBLIC_READ_LIMIT` (60/min), and the only public route
(`/api/public/eik-check`) is a GET that uses it. **There is no public mutation
tier.**

The decision still stands — collecting identifiers you did not need is not
undoable, and adding a column later is a migration — but its safety argument
has a missing term. Nothing writes the table yet, so the gap is not live; it is
a PRECONDITION of P5.2 rather than a detail of it, because
`POST /api/public/notices` is an unauthenticated writer and without a mutation
tier the only thing between it and a flood is the absence of the route.

## Still open on #1553

- **DECISION 6** — the `ReportReasonCode` category list. An enum rather than
  free text is settled (a count by reason must not require reading anyone's
  `detail`); the eight values are a draft of mine, flagged as provisional.
  Adding a value is a trivial migration.
- **DECISION 4** — whether a `MODERATOR` role is wanted. Assumed NOT: every
  existing role is tenant-scoped and a platform moderator is not a member of a
  farm.
- **P5.6** — delete-by-pseudonymisation needs a GDPR position before the
  erasure path can touch these tables.
