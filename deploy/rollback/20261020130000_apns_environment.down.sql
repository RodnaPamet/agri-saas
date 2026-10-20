-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK — undo `20261020130000_apns_environment`
-- ═══════════════════════════════════════════════════════════════════════
--
-- WHY THIS FILE EXISTS
--
-- Pinning Watchtower to the previous image does NOT undo a migration, and
-- `deploy/rollback/README.md` requires an inverse for every DROP. This one
-- drops both a column and a type.
--
-- ── WHAT THIS RESTORES, AND WHAT IT DOES NOT ─────────────────────────
--
-- RESTORES: nothing, because at the moment this is runnable there is nothing
-- to lose. The column ships one release ahead of its writer, and production
-- held zero `PushSubscription` rows of either platform when it was added.
--
-- DOES NOT RESTORE: the per-device environment, once phones have registered.
-- That direction is recoverable without data loss but not silently: every
-- iOS client sends the value on every registration — it reads it from its own
-- provisioning profile rather than remembering what the server knew — so the
-- rows repopulate as devices launch. Until they do, the sender refuses those
-- rows and logs them, which is the designed behaviour for a NULL and not a
-- new failure mode.
--
-- The visible symptom is therefore delayed pushes to phones that have not
-- launched since the rollback, not lost registrations.
--
-- ── THE ORDER OF THE TWO DROPS ───────────────────────────────────────
--
-- The column goes first and the type second. Postgres refuses to drop a type
-- a column still uses, so the reverse order fails on the first statement and
-- leaves the rollback half-applied — inside a transaction that means nothing
-- is applied, which is safe but looks like the script is broken.
--
-- ── THE `_prisma_migrations` ROW ──────────────────────────────────────
--
-- The last statement deletes the migration's bookkeeping row, and it is
-- load-bearing rather than tidy-up. `prisma migrate deploy` decides what to
-- run by consulting that table, so leaving the row makes a later roll-forward
-- SKIP this migration as already-applied — new code, old schema.
--
-- down → up → down all work: both drops are guarded, and the forward
-- migration's CREATE TYPE is not, so a re-apply after this script is what
-- recreates it.

BEGIN;

ALTER TABLE "PushSubscription" DROP COLUMN IF EXISTS "apnsEnvironment";
DROP TYPE IF EXISTS "ApnsEnvironment";

-- ── Bookkeeping ──────────────────────────────────────────────────────
-- See the header: without this, a later roll-forward silently skips the add.
DELETE FROM "_prisma_migrations"
 WHERE "migration_name" = '20261020130000_apns_environment';

COMMIT;
