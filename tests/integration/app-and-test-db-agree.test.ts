/**
 * The app and the tests use the SAME database. (#1265)
 *
 * ## The defect
 *
 * `jest.setup.js` resolved the app's `DATABASE_URL` from `.env.test`/`.env`
 * itself and did not apply the per-checkout slot, repointing only when
 * globalSetup had written a `perWorker` marker. So on any serial or
 * single-worker run the app and the test clients diverged — differently per
 * checkout, measured 2026-10-03:
 *
 *   test side                     app side
 *   agri_saas_test_c1a111b87      agri_saas_test            an unslotted TEST db
 *   agri_saas_test_cde5cee23      :5436/agri_saas           a real DEV database
 *
 * The first is SILENT: a raw `pg` read counts rows in a database the app never
 * wrote to, returns 0, and `expect(count).toBe(0)` passes on that zero. The
 * second is the hazard `jest.setup.js`'s own header warns about verbatim — "or
 * worse, PASSED by writing to real development data" — and it failed loudly
 * only because that port happened not to be listening.
 *
 * ## The cause was not where it looked
 *
 * Aligning `jest.setup.js` alone produced 23 FK violations across 6 suites,
 * because `getBaseTestDatabaseUrl()` returned the UNSLOTTED url in worker
 * context. It has two branches for the same value: branch 1 returns
 * `process.env.DATABASE_URL_TEST` VERBATIM — correct for CI, which exports it
 * and migrates that exact name outside jest — and branch 2 reads the identical
 * value from the identical file and applies the slot.
 *
 * **dotenv loads `.env.test` into `process.env`** (the run prints `injected env
 * (1) from .env.test`), so a LOCAL file value arrived through the CI door and
 * was treated as a pin. The same configuration resolved to two databases
 * depending on whether dotenv had run yet. Branch 1 now slots a non-CI value.
 *
 * ## Why this test asserts on FOUR resolvers
 *
 * An earlier version of this file compared only `DB_URL` against
 * `process.env.DATABASE_URL` and passed while the real divergence was in
 * `getTestDatabaseUrl()` — the one `prismaTestClient()` actually uses. The
 * resolver a test client uses is the one that has to agree.
 */
import {
    getTestDatabaseUrl,
    getBaseTestDatabaseUrl,
    prismaTestClient, isParallelRun } from '../helpers/db';

import { DB_URL, DB_AVAILABLE } from './db-helper';

/** The database name, or a label that cannot be mistaken for one. */
function dbName(url: string | undefined): string {
    if (!url) return '(unset)';
    try {
        const name = new URL(url).pathname.replace(/^\//, '');
        return name === '' ? '(no path)' : name;
    } catch {
        return `(unparseable)`;
    }
}

/** Host:port, because one checkout's divergence crossed PORTS, not just names. */
function dbHost(url: string | undefined): string {
    if (!url) return '(unset)';
    try {
        const u = new URL(url);
        return `${u.hostname}:${u.port || '(default)'}`;
    } catch {
        return '(unparseable)';
    }
}

const OWNED = /^(agri_saas_test|ci_testdb)(_c[0-9a-f]{8})?(_w\d+)?$/;

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('the app and the tests use the same database (#1265)', () => {
    it('control: every resolver returns something parseable', () => {
        // "They all agree" is also what four `(unset)` values produce.
        for (const [label, url] of [
            ['process.env.DATABASE_URL', process.env.DATABASE_URL],
            ['db-helper DB_URL', DB_URL],
            ['getTestDatabaseUrl()', getTestDatabaseUrl()],
            ['getBaseTestDatabaseUrl()', getBaseTestDatabaseUrl()],
        ] as const) {
            expect(dbName(url)).not.toMatch(/^\(/);
            expect(label).toBeTruthy();
        }
    });

    it('the three LIVE resolvers name one database, and base relates to it correctly', () => {
        // Three resolvers, not four (#1502).
        //
        // `getBaseTestDatabaseUrl` is by definition the UNSLOTTED base, so
        // under per-worker isolation it differs from the three that actually
        // carry a connection — and that difference is the isolation WORKING:
        //
        //     app          agri_saas_test_cde5cee23_w1
        //     dbHelper     agri_saas_test_cde5cee23_w1
        //     testClient   agri_saas_test_cde5cee23_w1
        //     base         agri_saas_test_cde5cee23      <- correct, not a fault
        //
        // Comparing all four therefore failed on EVERY parallel local run and
        // passed only under CI's `--runInBand`, where there is one worker and
        // no suffix. A developer running the integration suite the obvious way
        // got the message below — which warns that the run may be writing to
        // development data — while the isolation was in fact correct.
        //
        // A safety check that cries wolf is one people learn to run with
        // `--runInBand` and stop reading, which is the ending the `::notice`
        // flake annotations had before #1076.
        //
        // So the three that must agree are compared, the loud message is kept
        // for the divergence it was written for (#1265: the app side once
        // resolved to a real DEV database), and `base`'s own relationship is
        // asserted separately below — equal when serial, their prefix when
        // parallel, which is the invariant that holds in both modes.
        const seen = {
            app: dbName(process.env.DATABASE_URL),
            dbHelper: dbName(DB_URL),
            testClient: dbName(getTestDatabaseUrl()),
        };
        const distinct = [...new Set(Object.values(seen))];
        if (distinct.length !== 1) {
            throw new Error(
                `The app and the tests are pointed at DIFFERENT databases.\n` +
                    Object.entries(seen)
                        .map(([k, v]) => `  ${k.padEnd(12)} ${v}`)
                        .join('\n') +
                    `\n  hosts: app ${dbHost(process.env.DATABASE_URL)}, ` +
                    `testClient ${dbHost(getTestDatabaseUrl())}\n\n` +
                    `Every integration assertion that READS through a raw pg client and\n` +
                    `WRITES through the app path is meaningless in this state, and a count\n` +
                    `reading zero is indistinguishable from a row never written. If the app\n` +
                    `side is a dev database, a run here WRITES TO DEVELOPMENT DATA.\n\n` +
                    `See #1265: jest.setup.js must take the database from the globalSetup\n` +
                    `marker, and getBaseTestDatabaseUrl must slot a non-CI DATABASE_URL_TEST.`,
            );
        }
        expect(distinct).toHaveLength(1);

        // `base` is not a connection, so it is asserted by RELATIONSHIP.
        // Getting this wrong in the other direction would be worse than the
        // bug: if base and the live three were unrelated strings, the slotting
        // would be broken and every per-worker clone would be pointing
        // somewhere unintended — which is exactly #1265. So this still fails
        // when it should, it just no longer fails when it should not.
        const base = dbName(getBaseTestDatabaseUrl());
        const live = distinct[0]!;
        if (isParallelRun()) {
            expect(live).toMatch(
                new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_w\\d+$`),
            );
        } else {
            expect(live).toBe(base);
        }
    });

    it('...and it is a database this repo OWNS, never a dev or prod one', () => {
        // Agreeing on the WRONG database is still a loss.
        expect(dbName(process.env.DATABASE_URL)).toMatch(OWNED);
        expect(dbName(getTestDatabaseUrl())).toMatch(OWNED);
    });

    it('DIRECT_DATABASE_URL agrees too — migrations must not split off', () => {
        // RLS setup and migrations go through the DIRECT url; a split there
        // migrates one database while the tests use another.
        expect(dbName(process.env.DIRECT_DATABASE_URL)).toBe(dbName(process.env.DATABASE_URL));
    });

    it('the cached test CLIENT is on that database, not just the resolver', () => {
        // `prismaTestClient()` memoises `_client` on first call, so a resolver
        // that agrees now says nothing about a client built earlier in the run.
        // Writing and reading back through it is what proves the live object.
        const client = prismaTestClient() as { $queryRawUnsafe: (q: string) => Promise<unknown> };
        return (client.$queryRawUnsafe('SELECT current_database() AS db') as Promise<
            Array<{ db: string }>
        >).then((rows) => {
            expect(rows[0].db).toBe(dbName(process.env.DATABASE_URL));
        });
    });
});
