#!/bin/sh
# Block until the database schema is fully migrated. P1.8.
#
# ── why the worker needs this and the app does not ──
#
# The app's ENTRYPOINT (`scripts/entrypoint.sh`) runs `prisma migrate deploy`
# and only then starts Next, so by the time it serves a request the schema is
# current. The worker OVERRIDES that entrypoint in the compose file
# (`entrypoint: ["/bin/sh","-c"]`, `command: ["node dist/scheduler.mjs && node
# dist/worker.mjs"]`), so it has never run or waited for a migration. Its
# `depends_on` waits for pgbouncer and redis to report HEALTHY, and a healthy
# database is not a migrated one.
#
# Watchtower recreates app and worker together, so on any deploy carrying a
# migration the worker can open a connection and start consuming jobs against
# the OLD schema while the app is still applying it. A job that reads a column
# added by that migration fails; one that writes a row the new constraint
# rejects fails later and less obviously.
#
# ── why WAIT rather than apply ──
#
# Two containers racing `migrate deploy` is not a race Prisma's advisory lock
# makes pleasant, and it would make the worker a second source of schema
# authority. Waiting keeps exactly one applier.
#
# ── why `migrate status` and not a table probe ──
#
# `prisma migrate status` exits non-zero while any migration is PENDING, and
# also when the database is unreachable or has drifted. All three are states
# the worker must not start in, so a single exit-code poll covers them without
# encoding a list of tables that would go stale.
#
# ── why BOUNDED ──
#
# `restart: always` makes an exit a visible, repeating event in `docker ps` and
# the logs. An unbounded loop would make a permanently failing migration look
# like a worker that is merely quiet — the failure mode this whole script
# exists to make loud.
set -e

PRISMA="./node_modules/.bin/prisma"
SCHEMA="./prisma/schema"
MAX_ATTEMPTS="${MIGRATION_WAIT_ATTEMPTS:-60}"
SLEEP_SECONDS="${MIGRATION_WAIT_INTERVAL:-2}"

if [ ! -x "$PRISMA" ]; then
    echo "✗ prisma CLI not found at $PRISMA — it must stay in dependencies, not devDependencies" >&2
    exit 1
fi

echo "→ Waiting for database migrations to be applied..."
attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
    if "$PRISMA" migrate status --schema="$SCHEMA" >/dev/null 2>&1; then
        echo "✓ Schema is up to date (after $attempt attempt(s))"
        exit 0
    fi
    # Print the reason every tenth attempt rather than every one: the output is
    # several lines and a 2-minute wait would otherwise bury the worker's own
    # startup log in repeated identical blocks.
    if [ $((attempt % 10)) -eq 1 ]; then
        echo "  … not ready (attempt $attempt/$MAX_ATTEMPTS). Latest status:"
        "$PRISMA" migrate status --schema="$SCHEMA" 2>&1 | sed 's/^/    /' || true
    fi
    attempt=$((attempt + 1))
    sleep "$SLEEP_SECONDS"
done

echo "✗ Migrations still not applied after $MAX_ATTEMPTS attempts" >&2
echo "  The worker is exiting so 'restart: always' surfaces this as a" >&2
echo "  restarting container rather than a silently idle one." >&2
exit 1
