# 2026-10-02 — P1.4: a NULL-tenant row belongs to one user; the org rules become read-only

**Commit:** `<sha> feat(security): P1.4 — user-scoped null-tenant RLS + read-only org rules`

## Design

Five policies change, in two groups.

**Group 1 — `UserSession`, `NativeRefreshToken`, `NativeAuthCode`.** All three
carried the Epic D.1 asymmetric policy with an *unconditional* NULL arm:

```sql
USING ("tenantId" IS NULL OR "tenantId" = app.tenant_id)
WITH CHECK ("tenantId" = app.tenant_id)
```

so under `app_user` any session could read **every** null-tenant row of all
three tables — session metadata (`ipAddress`, `userAgent`, `lastActiveAt`),
refresh-token rows, in-flight native auth codes, for every user on the
deployment. On the DELETE side, a session-takedown and token-revocation vector.

D.1's own comment says why the arm exists — "legitimate pre-tenant-resolution
sign-in state", because `recordNewSession` runs before a tenant is known. Still
true. What it does not require is that the row be readable by somebody *else*,
so the arm is narrowed rather than removed:

```sql
USING ("tenantId" = app.tenant_id
       OR ("tenantId" IS NULL AND "userId" = app.user_id))
```

**Group 2 — `Organization`, `OrgMembership`.** Both were `FOR ALL` with **no
`WITH CHECK`**, and Postgres uses a policy's `USING` expression as its check
when `WITH CHECK` is absent. So `OrgMembership`'s `USING ("userId" = app.user_id)`
let an `app_user` session **INSERT a membership for itself** — a self-grant of
the thing org membership exists to gate — and also DELETE its own row or UPDATE
it to another organization. `Organization`'s `EXISTS(…membership…)` let a member
UPDATE the organization row. INSERT happened to fail there (a brand-new
organization has no membership yet, so the check cannot pass), which is luck
rather than design.

`FOR SELECT` says what was meant. It leaves no implicit write check to inherit,
and with no write policy present an `app_user` write is refused outright.

The asymmetry between the groups is deliberate: the session/token tables keep a
`WITH CHECK` because an `app_user` write to them is a legitimate future shape (a
tenant-scoped session row). An org membership written by the person it grants
access to is not.

## This is defence in depth placed ahead of the code that needs it

Measured 2026-10-02: **nothing reads any of these five tables under `app_user`.**
Every access uses the global Prisma client or an explicit `asSystem(…)` — which
is `runWithAuditContext({source:'system'})`, an audit marker and *not* a role
switch — so `superuser_bypass` fires and these policies are inert in production.
`app.user_id` is also set by nothing in `src/`, so `"userId" = NULL` already
filtered every row of the org policies. Doubly inert: a loaded gun, not a live
leak, and the thing that would fire it is P1.5 routing person-scoped reads
through `app_user`.

That ordering is why the new policy is written to **fail closed**. With
`app.user_id` unset, `"userId" = current_setting('app.user_id', true)` is NULL,
the OR arm is NULL, and a null-tenant row is INVISIBLE under `app_user`. A
future path that enters `app_user` without setting the variable sees zero rows
rather than everyone's.

## Files

| File | Role |
| --- | --- |
| `prisma/migrations/20261002080000_p1_4_user_scoped_null_tenant_rls/migration.sql` | The five policies |
| `…/migration.down.sql` | The inverse, with what rolling back costs stated |
| `tests/integration/null-tenant-user-scoping.test.ts` | Behaviour + the policy-swap control |
| `tests/integration/user-session-rls.test.ts` | D.1's assertion 4 moved to the new contract; the silent-no-op case pinned |
| `tests/guards/null-tenant-tables-not-read-as-app-user.test.ts` | Keeps the measurement above from going stale |

## Decisions

- **Fail closed rather than permissive-when-unset.** The alternative —
  `coalesce(current_setting(…),'') = '' OR userId = …` — would be inert today
  and become real with P1.5. Failing closed is the right default for an
  isolation control, and the measurement showing no `app_user` reader is what
  makes it provably safe now. The tripwire guard is what keeps that true.
- **A `.down.sql`, though nothing demanded one.** `DROP POLICY` is not in the
  destructive set `destructive-migration-has-inverse.test.ts` derives (DROP
  TABLE / COLUMN / TYPE / RENAME). But the forward migration REPLACES a policy,
  so the previous image's behaviour cannot be recovered by pinning Watchtower
  back — the schema object is gone. The rule the guard encodes applies.
- **The single-policy form is preserved.** Unchanged from D.1: Postgres ORs
  permissive policies on the same command, and a permissive policy with no
  `WITH CHECK` implicitly grants `WITH CHECK (true)` on UPDATE for visible rows.
  Splitting into read + insert policies would let an `app_user` session UPDATE a
  null-tenant row to any tenantId.
- **The guard demands registration, not classification.** It cannot follow a
  call graph, so it catches the common shape — one module doing both — and says
  so. A failure means "read the file", not "you broke it".

## What the proofs caught

**Two mutation proofs that could not reach the subject, and both read as
success.** This is the finding worth keeping:

1. Reverting the policy with `psql` against the base test database — jest's
   `globalSetup` re-runs `prisma migrate deploy` and re-clones per worker on
   every run, so the revert was undone before any test saw it.
2. Editing the migration FILE — `_prisma_migrations` already records the
   migration as applied, so `migrate deploy` skips it and the file has no
   further influence on a migrated database.

Both left 12/12 green, which is indistinguishable from "the tests are fine".
Diagnosed by measuring instead of theorising: a diagnostic test printed
`current_user=app_user`, `app.user_id=null`, the live qual (already the P1.4
form), and both migrations recorded. So the control now lives **inside** the
test: it swaps the policy to the D.1 form in place, runs the same query the
assertions run, and asserts the answer CHANGES — under D.1 user A sees user B's
row, under P1.4 they do not. The swap is restored in a `finally`; the honest
caveat is that it is not transactional, so a hard crash leaves that one
disposable worker clone on the old policy.

**Three fixture errors, each a different wrong model of the schema.** A made-up
`userId` fails 23503 before any policy is reached; `name` is `@map`'d to
`nameEncrypted` so a raw INSERT naming `name` fails 42703; and
`NativeRefreshToken.userSessionId` foreign-keys to `UserSession.id`, not
`.sessionId`. Also: `globalPrisma` is a bare `PrismaClient` with no
`pii-middleware`, so `user.create({ data: { email } })` writes neither
`emailEncrypted` nor `emailHash` and dies on a NOT NULL constraint whose message
names no column.

**An RLS rule that bites in two different shapes.** A write refused by RLS
raises 42501 only when the row is *visible*. When SELECT hides it, the write
affects zero rows and returns normally. So D.1's assertion 5 — "UPDATE cannot
reassign a NULL row" — started passing for the wrong reason once the row became
invisible, and needed `set_config('app.user_id', …)` to make the row visible
again before "WITH CHECK refuses" was a claim about anything. The same asymmetry
decides the org assertions: the `OrgMembership` INSERT *raises* (no row to hide,
nothing to satisfy), while the `Organization` UPDATE *affects zero rows* (`FOR
SELECT` leaves no policy applicable to UPDATE, so the row is not visible for
update). Every negative in the new file asserts the raised error or the row
COUNT, never merely that the call returned.

## Not in this change

`runInUserContext` and routing person-scoped reads through `app_user` — that is
**P1.5**, and it is what makes these policies live. Until then they are correct
and enforcing nothing, which is stated here rather than left to be discovered.
