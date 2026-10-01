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
import {
    applyCheckoutSlot,
    assertIsTestDatabase,
    checkoutDbSlot,
    getBaseTestDatabaseUrl,
    getDbName,
    migrateTestDb,
    slotForPath,
} from '../helpers/db';


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
    let calls: Array<{ cmd: string; env: NodeJS.ProcessEnv | undefined }> = [];
    const runner = (cmd: string, opts: { env?: NodeJS.ProcessEnv }) => {
        calls.push({ cmd, env: opts.env });
        return '';
    };
    /** Fails loudly rather than widening `getDbName` to accept undefined. */
    const envUrl = (env: NodeJS.ProcessEnv | undefined, key: string): string => {
        const v = env?.[key];
        if (!v) throw new Error(`migrateTestDb did not pass ${key} to the runner`);
        return v;
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
        expect(getDbName(envUrl(env, 'DATABASE_URL'))).toBe('agri_saas_test');
        expect(getDbName(envUrl(env, 'DIRECT_DATABASE_URL'))).toBe('agri_saas_test');
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

/**
 * The per-CHECKOUT axis (#1171 mode 3).
 *
 * `globalSetup` terminates every session on the base database and DROPs the
 * `_w<n>` clones. Correct for one run; two worktrees resolved the SAME name,
 * so the second recreated the databases under the first. Measured:
 * `rls-coverage` died with Postgres `57P01`, then passed 22/22 alone — a
 * DB-backed guardrail failing on connection teardown looks exactly like that
 * guardrail finding a real RLS defect.
 *
 * These are executing tests, not source scans: the slot is arithmetic and the
 * allowlist is a predicate, so both can be run rather than asserted about.
 */
describe('the per-checkout database slot (#1171 mode 3)', () => {
    describe('slotForPath — the property that actually prevents the collision', () => {
        it('two checkouts never collide', () => {
            // THE regression test. Before this, every worktree resolved one name.
            expect(slotForPath('/home/u/agri-saas')).not.toBe(
                slotForPath('/home/u/agri-saas-wt-fp-merge'),
            );
        });

        it('is stable for one checkout — a slot that moved would strand databases', () => {
            expect(slotForPath('/home/u/agri-saas')).toBe(slotForPath('/home/u/agri-saas'));
        });

        it('has the shape the allowlist admits, and nothing wider', () => {
            for (const root of ['/a', '/home/u/x', 'C:\\repos\\y', '']) {
                expect(slotForPath(root)).toMatch(/^_c[0-9a-f]{8}$/);
            }
        });

        it('a slotted name is accepted, including alongside a worker clone', () => {
            // The real parallel case is BOTH axes at once.
            const slot = slotForPath('/home/u/agri-saas');
            expect(() => assertIsTestDatabase(url(`agri_saas_test${slot}`), 't')).not.toThrow();
            expect(() => assertIsTestDatabase(url(`agri_saas_test${slot}_w3`), 't')).not.toThrow();
            expect(() => assertIsTestDatabase(url(`ci_testdb${slot}`), 't')).not.toThrow();
        });
    });

    describe('admitting the slot did not loosen the allowlist', () => {
        // The hazard in widening a safety predicate is admitting more than the
        // one shape you meant. Each of these would pass `(_.*)?`.
        it.each([
            ['a non-hex slot', 'agri_saas_test_cZZZZZZZZ'],
            ['a short slot', 'agri_saas_test_c1a111b8'],
            ['a long slot', 'agri_saas_test_c1a111b877'],
            ['trailing junk after a valid slot', 'agri_saas_test_c1a111b87_extra'],
            ['the other product wearing a valid slot', 'inflect_compliance_test_c1a111b87'],
            ['a slot on an unowned name', 'latest_backup_c1a111b87'],
        ])('still refuses %s', (_label, db) => {
            expect(() => assertIsTestDatabase(url(db), 't')).toThrow(/refusing to run/);
        });
    });

    describe('applyCheckoutSlot — extends OWNED names only', () => {
        it('extends a name this repo owns', () => {
            expect(getDbName(applyCheckoutSlot(url('agri_saas_test')))).toMatch(
                /^agri_saas_test_c[0-9a-f]{8}$/,
            );
        });

        it('leaves a FOREIGN name untouched, so it still fails closed', () => {
            // The teeth: suffixing indiscriminately would rename another
            // product's database INTO a name the allowlist accepts, which is
            // the opposite of what the allowlist is for.
            const foreign = url('inflect_compliance_test');
            expect(applyCheckoutSlot(foreign)).toBe(foreign);
            expect(() => assertIsTestDatabase(applyCheckoutSlot(foreign), 't')).toThrow();
        });

        it('does not double-slot or re-slot a worker clone', () => {
            expect(applyCheckoutSlot(url('agri_saas_test_w1'))).toBe(url('agri_saas_test_w1'));
            const once = applyCheckoutSlot(url('agri_saas_test'));
            expect(applyCheckoutSlot(once)).toBe(once);
        });

        it('preserves the rest of the URL — credentials, host, port, params', () => {
            const out = new URL(applyCheckoutSlot(url('agri_saas_test')));
            expect(out.username).toBe('u');
            expect(out.port).toBe('5435');
            expect(out.searchParams.get('schema')).toBe('public');
        });
    });

    describe('JEST_DB_SLOT', () => {
        const prev = process.env.JEST_DB_SLOT;
        afterEach(() => {
            if (prev === undefined) delete process.env.JEST_DB_SLOT;
            else process.env.JEST_DB_SLOT = prev;
        });

        it('pins an explicit slot', () => {
            process.env.JEST_DB_SLOT = 'deadbeef';
            expect(checkoutDbSlot()).toBe('_cdeadbeef');
        });

        it('an empty value opts out entirely', () => {
            process.env.JEST_DB_SLOT = '';
            expect(checkoutDbSlot()).toBe('');
        });

        it('a malformed value THROWS rather than silently opting out', () => {
            // Coercing to '' would reintroduce the exact collision the operator
            // set the variable to avoid, and would do it silently.
            process.env.JEST_DB_SLOT = 'NOT-HEX!';
            expect(() => checkoutDbSlot()).toThrow(/8 lowercase hex/);
        });
    });

    describe('CI parity — a pinned URL gets no slot', () => {
        const prev = process.env.DATABASE_URL_TEST;
        afterEach(() => {
            if (prev === undefined) delete process.env.DATABASE_URL_TEST;
            else process.env.DATABASE_URL_TEST = prev;
        });

        it('returns DATABASE_URL_TEST verbatim', () => {
            // CI runs `prisma migrate deploy` against this name OUTSIDE jest.
            // A slot here would migrate one database and test another.
            const pinned = url('ci_testdb');
            process.env.DATABASE_URL_TEST = pinned;
            expect(getBaseTestDatabaseUrl()).toBe(pinned);
            expect(getDbName(getBaseTestDatabaseUrl())).toBe('ci_testdb');
        });
    });
});
