# Migration rollback scripts

Prisma has no down-migrations. `prisma migrate deploy` only rolls
forward, and it runs from the container entrypoint
(`scripts/entrypoint.sh`), so **shipping an image is what applies a
migration to production**.

For most migrations that is fine — they are additive, and old code
ignores a new column. This directory is for the ones where it is not.

## Why a rollback script is ever needed

The two halves of a deploy roll back at different speeds. Pinning
Watchtower to the previous image reverts the *code*; it does nothing to
the *schema*. After a destructive or renaming migration, the old image
is querying objects that no longer exist — so an image-only rollback
does not degrade gracefully, it fails outright.

That leaves a snapshot restore, and the snapshot schedule is daily at
02:00 UTC (`docs/backup-restore.md`). Undoing a UI-level regression
would cost up to 24 hours of farm data. A rollback script turns that
into a rename that moves no rows.

## When to add one

Add a script here when a migration would break the previous image:

- renames a table, column, enum type, or enum **value**
- drops or narrows a column the previous image still writes
- rewrites persisted data the previous image still reads
  (`TenantCustomRole.permissionsJson` is the live example)

You do **not** need one for a plain additive migration.

## Contract every script here follows

1. **Named `<migration_directory_name>.down.sql`.** The pairing has to be
   obvious at 2am.
2. **One transaction.** `BEGIN;` … `COMMIT;`. Postgres DDL is
   transactional, so a failure part-way leaves the database untouched.
   A rollback runs under time pressure and must never half-apply.
3. **Deletes its own `_prisma_migrations` row.** This is load-bearing,
   not housekeeping. `migrate deploy` decides what to run by consulting
   that table — leave the row and a later roll-forward *skips* the
   migration as already-applied, putting new code on an old schema. That
   is the same outage in the opposite direction. Deleting the row makes
   the script reversible: down → up → down all work.
4. **Guarded to the same standard as the forward migration.** If the
   forward data statement is guarded on `jsonb_typeof` and idempotent,
   the mirror is too.
5. **Held by a guard test.** A rollback script is code that is never
   exercised until the worst possible moment, so something has to keep
   it true. Two guards, at different depths:
   - `tests/guards/destructive-migration-has-inverse.test.ts` DERIVES the
     destructive set by scanning every `migration.sql` for `DROP TABLE` /
     `DROP COLUMN` / `DROP TYPE` / `RENAME TO` / `RENAME COLUMN`, and
     requires each one to have a `.down.sql` that runs in one transaction
     and deletes its own `_prisma_migrations` row. Migrations that predate
     this directory sit in a `PREDATES_RULE` baseline with a stale-entry
     test; the baseline is not meant to grow. Because it derives rather
     than lists, a new drop is covered the moment it lands.
   - `tests/guards/rename-rollback-inverse.test.ts` guards ONE migration
     by hardcoded path and makes the deeper claim: a bijection between the
     forward migration's renames and the script's, in both directions,
     with a mutation proof.

## Running one

```bash
# 1. Stop the app + worker. Running DDL under a live app means in-flight
#    queries hit tables mid-rename.
gcloud compute ssh agrent --zone europe-west1-b --command \
  "cd /opt/agrent && sudo docker compose -f docker-compose.vm.yml stop app worker"

# 2. Apply against the DIRECT url — not PgBouncer. This is DDL in one
#    transaction, and PgBouncer runs in transaction-pooling mode.
psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f deploy/rollback/<name>.down.sql

# 3. Start the PREVIOUS image. Starting the new one re-applies the
#    forward migration from its entrypoint and puts you back where you
#    started.
```

`-v ON_ERROR_STOP=1` matters: without it psql keeps going after a failed
statement, and combined with the transaction wrapper you would get a
rolled-back transaction reported as a successful run.

## Current scripts

| Script | Undoes | Verified |
| --- | --- | --- |
| `20260809120000_rename_control_to_practice.down.sql` | The Control → Practice rename (8 tables, 19 columns, 4 enum types, 5 enum values, 77 index/constraint names, 1 jsonb rekey) | Executed against Postgres 16 with seeded rows: down → `Control*` with values, RLS and all three policies intact, permissions rekeyed with intent preserved; then `migrate deploy` rolled forward again and everything round-tripped. Residual drift 31 statements, none naming Control or Practice — the repo's pre-existing baseline. |
| `20260812180000_drop_payroll_expense.down.sql` | `DROP TABLE "PayrollExpense"`. Recreates the shape, the four FKs, the three indexes and the RLS trio, then reads the rows back out of `CostEntry WHERE category = 'PAYROLL'` — the forward data migration (`20260812090000`) reused the `PayrollExpense` id verbatim, which is what makes an id-for-id restore possible. | Not executed against a live database. It restores what a pinned-back image can use; it cannot restore `supplier` / invoice / location / parcel / lease / item data a `CostEntry` gained after the copy, because the old table has no columns for those. |
