# 2026-08-24 — Renaming the production database

**Commit:** `<pending> chore(deploy): rename the production database to agrent_production`

## Why this was not free

The name `inflect_production` was not an oversight. It sat in
`tests/guards/no-legacy-brand.test.ts` as a deliberate carve-out —
*"production DB names — operator-side, migration-noted"* — alongside entries
that are genuinely load-bearing (encryption salts, whose rename *"breaks
decryption of all existing ciphertext"*; auth cookie names, which break
in-flight invites). Someone decided to leave it, and recorded the decision.

The rename was requested anyway, on the grounds that the name is confusing to
an operator poking at the `agrent` VM and finding a database called `inflect`.
That is a real cost, but it is a cost in human confusion, not in behaviour, and
this note exists so the next person does not have to re-derive that.

## What made it safe to attempt

One thing decided the risk, and it was checked before anything moved:
**`POSTGRES_DB` is set explicitly in `/opt/agrent/.env`.**

Every other reference derives from it — the `db` service's own env and
healthcheck, pgbouncer's `DB_NAME` (from which it regenerates its `[databases]`
stanza), and both `DATABASE_URL` / `DIRECT_DATABASE_URL` for app and worker. The
`:-inflect_production` defaults in the compose files are therefore a dead
fallback.

Had `POSTGRES_DB` been ABSENT from `.env`, editing the compose default alone
would have silently pointed the stack at a NEW, empty database. Postgres would
have created it, `prisma migrate deploy` would have populated a fresh schema,
and the app would have come up healthy against zero farms — a "successful"
deploy that loses every tenant. That is the failure this check ruled out, and it
is the reason to verify the variable is explicit before trusting a default.

## Order of operations

`ALTER DATABASE ... RENAME TO` requires **no connections** to the target, and
cannot be issued from inside it. So:

1. fresh disk snapshot (the scheduled one was ~17h old);
2. stop `app`, `worker` and `pgbouncer` — pgbouncer holds pooled connections and
   will keep the rename blocked;
3. `ALTER DATABASE`, issued while connected to the `postgres` database;
4. update `POSTGRES_DB` in `/opt/agrent/.env`;
5. `deploy/apply.sh` — ships the repo compose and health-verifies.

Steps 3 and 4 must not be separated by a restart: between them the stack points
at a name that no longer exists.

## Rollback

`ALTER DATABASE agrent_production RENAME TO inflect_production`, revert the
`.env` line, re-apply the previous compose. The snapshot is the backstop if the
cluster itself is damaged rather than merely misnamed.

## What was NOT renamed

`inflect_compliance` — the database of the **other** product on the
`inflect-compliance` VM, a different repo with live users. Its carve-out in the
brand guard is retained. CLAUDE.md already warns at length about conflating the
two; this is exactly that hazard in miniature, and the guard pattern was
narrowed rather than deleted for that reason.
