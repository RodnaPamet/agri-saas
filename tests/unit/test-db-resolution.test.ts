/**
 * The test bootstrap must never resolve to a database it does not own.
 *
 * This file exists because it already went wrong twice. `tests/helpers/db.ts`
 * once fell through to a container default named `inflect_test` — the same
 * name the sibling inflect-compliance checkout uses on the same host — and
 * applied this repo's migrations to the other product's database. The name was
 * made repo-specific to fix it, and the fix was UNREACHABLE: the branch that
 * returned it sat below a branch that returned `.env` first, so any checkout
 * with a `.env` (i.e. every checkout) still resolved to the dev database.
 *
 * The guard that should have caught it was `base.includes('test')`, placed at
 * the END of globalSetup — after the migrate, after `pg_terminate_backend`,
 * after the DROP/CREATE of the worker clones. It could not have prevented any
 * of them, and as a substring test it accepts `inflect_compliance_test`.
 *
 * So: an allowlist, checked before anything runs, proven by the cases that
 * would pass a substring test.
 */
import { assertIsTestDatabase, getBaseTestDatabaseUrl, getDbName, migrateTestDb } from '../helpers/db';


const url = (db: string) => `postgresql://u:p@127.0.0.1:5435/${db}?schema=public`;

describe('assertIsTestDatabase', () => {
    it.each(['agri_saas_test', 'ci_testdb', 'agri_saas_test_w1', 'ci_testdb_w12'])(
        'accepts %s',
        (db) => {
            expect(() => assertIsTestDatabase(url(db), 'test')).not.toThrow();
        },
    );

    /**
     * Every one of these passes `name.includes('test')`. They are the reason
     * the predicate is an allowlist: a substring test is a denylist wearing an
     * allowlist's clothes, and only rejects the spellings someone thought of.
     */
    it.each([
        ['inflect_compliance_test', 'the other product, with a suffix'],
        ['agrent_production_testbed', 'production, with a suffix'],
        ['latest_backup', '"test" inside "latest"'],
        ['protest_db', '"test" inside "protest"'],
        ['contest_db', '"test" inside "contest"'],
    ])('refuses %s (%s) even though it contains "test"', (db) => {
        expect(() => assertIsTestDatabase(url(db), 'test')).toThrow(/refusing to run against database/);
    });

    it('refuses the other product outright', () => {
        expect(() => assertIsTestDatabase(url('inflect_compliance'), 'test')).toThrow(
            /refusing to run against database "inflect_compliance"/,
        );
    });

    it('names the resolved database and the allowed ones, and hides the password', () => {
        try {
            assertIsTestDatabase('postgresql://u:hunter2@h:5432/inflect_compliance', 'globalSetup');
            throw new Error('expected a throw');
        } catch (err) {
            const msg = (err as Error).message;
            expect(msg).toContain('inflect_compliance');
            expect(msg).toContain('agri_saas_test');
            expect(msg).not.toContain('hunter2');
        }
    });
});

describe('getBaseTestDatabaseUrl', () => {
    /**
     * The invariant, independent of which branch resolves it: whatever this
     * returns must be a database the tests own. A `.env` naming a dev or
     * foreign database must never reach the caller — that is the exact shape
     * of the checkout this defect was found in.
     */
    it('always resolves to a database this repo owns', () => {
        expect(() => assertIsTestDatabase(getBaseTestDatabaseUrl(), 'getBaseTestDatabaseUrl')).not.toThrow();
    });

    it('honours DATABASE_URL_TEST above everything else', () => {
        const prev = process.env.DATABASE_URL_TEST;
        process.env.DATABASE_URL_TEST = url('ci_testdb');
        try {
            expect(getDbName(getBaseTestDatabaseUrl())).toBe('ci_testdb');
        } finally {
            if (prev === undefined) delete process.env.DATABASE_URL_TEST;
            else process.env.DATABASE_URL_TEST = prev;
        }
    });
});

describe('migrateTestDb', () => {
    const saved = { t: process.env.DATABASE_URL_TEST, d: process.env.DIRECT_DATABASE_URL };
    let calls: Array<{ cmd: string; env: NodeJS.ProcessEnv }> = [];
    const runner = (cmd: string, opts: { env?: NodeJS.ProcessEnv }) => {
        calls.push({ cmd, env: opts.env ?? {} });
        return '';
    };
    beforeEach(() => {
        calls = [];
        process.env.DATABASE_URL_TEST = url('agri_saas_test');
    });
    afterEach(() => {
        if (saved.t === undefined) delete process.env.DATABASE_URL_TEST;
        else process.env.DATABASE_URL_TEST = saved.t;
        if (saved.d === undefined) delete process.env.DIRECT_DATABASE_URL;
        else process.env.DIRECT_DATABASE_URL = saved.d;
    });

    /**
     * prisma.config.ts reads `DIRECT_DATABASE_URL ?? DATABASE_URL`, so pinning
     * only DATABASE_URL leaves an exported DIRECT_DATABASE_URL outranking the
     * URL we just resolved and validated — bypassing the resolution entirely.
     */
    it('pins DIRECT_DATABASE_URL as well, so an exported decoy cannot win', () => {
        process.env.DIRECT_DATABASE_URL = 'postgresql://u:p@127.0.0.1:5439/decoy_direct_db?schema=public';
        migrateTestDb(runner);
        const env = calls[0].env;
        expect(getDbName(env.DATABASE_URL)).toBe('agri_saas_test');
        expect(getDbName(env.DIRECT_DATABASE_URL)).toBe('agri_saas_test');
    });

    /** A success line that is not conditional on success is decoration. */
    /**
     * An UNREACHABLE database is tolerated — guard and unit suites run without
     * one and DB_AVAILABLE skips the rest. It must not be reported as success.
     */
    it('reports an unreachable database as unreachable, not as a migration', () => {
        expect(
            migrateTestDb(() => {
                throw new Error("P1001: Can't reach database server at `127.0.0.1:5435`");
            }),
        ).toBe('unreachable');
    });

    /**
     * A migration that FAILS against a REACHABLE database must fail the run.
     * DB_AVAILABLE is a liveness probe: it cannot tell that the schema never
     * applied, so tolerating this is what lets suites run against an
     * unmigrated database.
     */
    it('rethrows a real migration failure', () => {
        expect(() =>
            migrateTestDb(() => {
                throw new Error('P3009: migrate found failed migration in the target database');
            }),
        ).toThrow(/P3009/);
    });

    it('refuses to migrate a database this repo does not own', () => {
        process.env.DATABASE_URL_TEST = url('inflect_compliance');
        expect(() => migrateTestDb(runner)).toThrow(/refusing to run against database/);
        expect(calls).toHaveLength(0);
    });
});
