/**
 * Jest globalSetup: runs once before all suites.
 * - Migrates the base/template test DB.
 * - When Jest runs >1 worker, TEMPLATE-clones the migrated base into
 *   one DB per worker (`<base>_w<id>`) so parallel integration tests
 *   (which TRUNCATE in beforeEach) never contend on a shared DB —
 *   the deadlock/data-race flake class. Serial runs (`--runInBand`,
 *   CI) skip cloning and stay on the shared base DB (unchanged path).
 * - Writes a marker the worker-side `getTestDatabaseUrl()` reads.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import {
    migrateTestDb,
    getBaseTestDatabaseUrl,
    assertIsTestDatabase,
    getDbName,
    adminConnectionString,
    PER_WORKER_MARKER,
} from '../helpers/db';
import { assertNoForeignMutation } from '../helpers/selector-teeth-marker';

interface GlobalConfig { maxWorkers?: number }

/**
 * Delete undrainable `StatementOfReasons` litter from the BASE database —
 * #2574.
 *
 * ## What the litter is, and why it never leaves on its own
 *
 * `runStatementDispatch` resolves a recipient per row and, finding none, skips
 * the row and leaves it undelivered. That is deliberate and correct: the
 * console's undelivered view is where a real Art 17 compliance gap must stay
 * visible. But a statement whose recipient `User` no longer EXISTS can never
 * drain — there is no mailbox to resolve, ever — so in a test database it is
 * not a compliance gap, it is litter the dispatch will skip forever.
 *
 * ## Why it breaks a suite rather than merely accumulating
 *
 * The dispatch takes the **50 oldest** undelivered rows (`orderBy: createdAt
 * asc`, `DEFAULT_BATCH = 50`). Once the undrainable pile crosses that, a batch
 * is spent entirely on rows that skip and a suite's freshly-seeded statement is
 * never reached — which surfaces as `Cannot read properties of undefined`
 * three frames from its cause (#2522). Measured on this checkout before the
 * fix: 130 undelivered, **128 of them orphaned**, oldest 2026-11-02. The issue
 * was filed at 111; it only grows.
 *
 * ## Why HERE, and not in the suites
 *
 * The suites are not the leak. Every suite that mints statements already
 * deletes them in `afterAll`, by id. The rows come from runs that were
 * INTERRUPTED — a killed run never reaches `afterAll`, and the suites that own
 * this queue mock `sendEmail`, so nothing is ever stamped delivered. A
 * per-suite pre-clean is only available to a suite that injects its own id
 * prefix (p5-4b does, and scopes to `sor-p54b-%`); the real `queueStatement`
 * mints an untagged `sor-<id>`, so there is no prefix for the others to scope
 * by. All 128 orphans carry that untagged shape.
 *
 * And it must be the BASE, not a worker clone: the per-worker databases are
 * `CREATE DATABASE … TEMPLATE <base>`, so litter in the base is copied into
 * every clone on every run. Cleaning a clone leaves the base to re-seed it.
 * Hence this runs after the migration and BEFORE the clone loop.
 *
 * ## Why not a cascade
 *
 * `StatementOfReasons.recipientUserId` deliberately carries no
 * `onDelete: Cascade`: P5.6b's erasure design KEEPS the row and pseudonymises,
 * because a statement is the record of a decision. That is right for
 * production and must not be changed for a test's convenience.
 *
 * Tolerant by construction: it only runs when the migration reported
 * `migrated`, and any failure is reported and swallowed — a hygiene step must
 * never be the reason a test run cannot start.
 */
export async function pruneUndrainableStatements(baseUrl: string): Promise<void> {
    const client = new Client({ connectionString: baseUrl });
    try {
        await client.connect();
        const res = await client.query(`
            DELETE FROM "StatementOfReasons" s
             WHERE s."deliveredAt" IS NULL
               AND NOT EXISTS (
                   SELECT 1 FROM "User" u WHERE u.id = s."recipientUserId"
               )
        `);
        // Printed with its denominator rather than only when non-zero: zero is
        // the reading that says the base is clean, and a step that prints
        // nothing on a clean run is indistinguishable from one that did not run.
        const remaining = await client.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM "StatementOfReasons" WHERE "deliveredAt" IS NULL`,
        );
        console.log(
            `[test-setup] statement litter: pruned ${res.rowCount ?? 0} undrainable row(s); `
            + `${remaining.rows[0]?.n ?? '?'} undelivered remain (#2574)`,
        );
    } catch (err) {
        // Never fatal. A missing table (a tree that predates P5.1) and an
        // unreachable server both land here, and neither is a reason to refuse
        // to run the tests.
        console.warn(
            `[test-setup] statement-litter prune skipped: `
            + `${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
        );
    } finally {
        await client.end().catch(() => {});
    }
}

export default async function globalSetup(globalConfig?: GlobalConfig) {
    const base = getBaseTestDatabaseUrl();

    // FIRST, before anything reads or writes. Everything below this line
    // migrates, terminates connections on, clones and DROPs databases derived
    // from `base`. The check this replaced sat at the END of this function,
    // after all of it — so it could not have prevented a single one of them.
    assertIsTestDatabase(base, 'globalSetup');

    // A sweep holding a guard file gutted makes every result from this run a
    // statement about the mutation (#1171 mode 1). Placed AFTER the test-database
    // assertion deliberately: that one must stay first, and this check touches
    // no database. Exempts the sweep's own child; SELECTOR_TEETH_ALLOW_CONCURRENT=1
    // downgrades it to a warning.
    assertNoForeignMutation('globalSetup');

    const baseName = getDbName(base);

    console.log(`\n[test-setup] Database URL: ${base.replace(/:[^@]*@/, ':***@')}`);

    // The base database may not EXIST yet. Since #1171 the local name carries
    // a per-checkout slot (`_c<hash>`, see `checkoutDbSlot`), so the first run
    // in a fresh worktree names a database nothing has created. CI is
    // unaffected — it pins DATABASE_URL_TEST and provisions the database as a
    // service — but creating it here rather than relying on
    // `prisma migrate deploy` to do it keeps the behaviour independent of
    // Prisma's internals, which is a dependency we would otherwise be
    // asserting without a test.
    //
    // An unreachable server stays TOLERATED: guard and unit suites run with no
    // database at all, and `migrateTestDb()` below reports `unreachable` for
    // the same condition. This must not turn that into a hard failure.
    await ensureBaseDatabase(baseName);
    console.log(`[test-setup] Running migrations on base DB...`);
    // The success line is CONDITIONAL on success. It used to print
    // unconditionally while `migrateTestDb` swallowed its own failure, so
    // "Migration failed (DB may not be running)" and "Migrations complete"
    // appeared four lines apart in the same run — a healthy path and a broken
    // path with identical observables.
    //
    // An unreachable database is still tolerated: guard and unit suites run
    // without one, and DB_AVAILABLE skips the suites that need it. A
    // migration that FAILS against a reachable database is not tolerated,
    // because DB_AVAILABLE is a liveness probe and cannot see it.
    if (migrateTestDb() === 'migrated') {
        console.log(`[test-setup] Migrations complete`);
        // BEFORE the clone loop below, so no worker inherits the litter.
        await pruneUndrainableStatements(base);
    } else {
        console.warn(
            `[test-setup] Migrations NOT run — database unreachable. ` +
                `Suites that need a database will skip (DB_AVAILABLE=false).`,
        );
    }

    const maxWorkers = globalConfig?.maxWorkers ?? 1;
    let marker = { perWorker: false, count: 1, baseName, baseUrl: base };

    if (maxWorkers > 1) {
        // TEMPLATE-clone the migrated base into one DB per worker. Fast
        // (Postgres copies the data files); roles are cluster-global so
        // RLS app_user etc. are shared, policies/grants are copied.
        try {
            const admin = new Client({ connectionString: adminConnectionString() });
            await admin.connect();
            // CREATE DATABASE ... TEMPLATE requires the template idle.
            // Terminate any stray sessions on it (e.g. a leaked client
            // from a prior run) so the clone never fails spuriously.
            await admin.query(
                `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                 WHERE datname = $1 AND pid <> pg_backend_pid()`,
                [baseName],
            );
            for (let i = 1; i <= maxWorkers; i++) {
                const wdb = `${baseName}_w${i}`;
                await admin.query(`DROP DATABASE IF EXISTS "${wdb}" WITH (FORCE)`);
                await admin.query(`CREATE DATABASE "${wdb}" TEMPLATE "${baseName}"`);
            }
            await admin.end();
            marker = { perWorker: true, count: maxWorkers, baseName, baseUrl: base };
            console.log(`[test-setup] Per-worker DB isolation: ${baseName}_w1..w${maxWorkers}`);
        } catch (err) {
            // No CREATEDB / older Postgres / template busy — degrade to the
            // shared base DB (correct only when run serially, but never
            // crashes setup).
            console.warn(
                `[test-setup] Per-worker DB isolation unavailable (${err instanceof Error ? err.message : err}); ` +
                    `falling back to the shared base DB — run integration with --runInBand to stay deadlock-free.`,
            );
        }
    }

    fs.mkdirSync(path.dirname(PER_WORKER_MARKER), { recursive: true });
    fs.writeFileSync(PER_WORKER_MARKER, JSON.stringify(marker));

}

/**
 * Create the base test database if it is absent. Never throws.
 *
 * `assertIsTestDatabase` has already run on the URL this name came from, so
 * the name is one of the two this repo owns, optionally slotted — see
 * ALLOWED_TEST_DB.
 */
async function ensureBaseDatabase(name: string): Promise<void> {
    let admin: Client | undefined;
    try {
        admin = new Client({ connectionString: adminConnectionString() });
        await admin.connect();
        const res = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
        if (res.rowCount === 0) {
            await admin.query(`CREATE DATABASE "${name}"`);
            console.log(`[test-setup] created ${name} — first run in this checkout`);
        }
    } catch {
        // Unreachable or insufficient privilege: tolerated by design. The
        // migration step reports the same condition and DB_AVAILABLE skips
        // the suites that need a database.
    } finally {
        try {
            await admin?.end();
        } catch {
            /* already gone */
        }
    }
}
