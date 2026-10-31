/**
 * The test-database resolver refuses rather than falling back to a dev one
 * (#2531).
 *
 * This is the branch that matters and the one hardest to reach: it only fires
 * on a machine with no `.env.test`, and `db:test:up` now writes one — so on
 * every developer's checkout, and in CI, the refusal is unreachable. Hence
 * `resolveDbUrlFrom`, which takes the four sources as data.
 *
 * What went wrong without it: 51 suites in one local full-root run reported
 * `P1001: Can't reach database server at 127.0.0.1:5436` — pgbouncer, from
 * `.env` — and every one of them passed when run alone. The fall-through
 * turned a missing file into 440 errors that named the wrong subject.
 */
import { resolveDbUrlFrom, type DbUrlSources } from '../../integration/db-helper';

const NONE: DbUrlSources = {
    fromHelper: () => undefined,
    envTestVar: undefined,
    envTestFile: () => undefined,
    envVar: undefined,
};

const SLOT = 'postgresql://u:p@127.0.0.1:5435/agri_saas_test_abc_w1?schema=public';

describe('precedence — the four sources, in order', () => {
    it('prefers the per-worker slot over everything else', () => {
        // It must win over `.env.test`: the slot is THIS worker's clone, and
        // `.env.test` names the shared base database. Losing that order is
        // the cross-DB data race the resolver's own docblock describes — the
        // app writing to one database while the test reads another.
        expect(resolveDbUrlFrom({
            fromHelper: () => SLOT,
            envTestVar: 'postgresql://u:p@localhost:5435/from-ci',
            envTestFile: () => 'postgresql://u:p@localhost:5435/from-file',
            envVar: 'postgresql://u:p@localhost:5435/from-env',
        })).toBe(SLOT);
    });

    it('falls to $DATABASE_URL_TEST next — the one CI sets', () => {
        expect(resolveDbUrlFrom({
            ...NONE,
            envTestVar: 'postgresql://u:p@localhost:5435/from-ci',
            envTestFile: () => 'postgresql://u:p@localhost:5435/from-file',
        })).toBe('postgresql://u:p@localhost:5435/from-ci');
    });

    it('then .env.test', () => {
        expect(resolveDbUrlFrom({
            ...NONE,
            envTestFile: () => 'postgresql://u:p@localhost:5435/from-file',
            envVar: 'postgresql://u:p@localhost:5435/from-env',
        })).toBe('postgresql://u:p@localhost:5435/from-file');
    });

    it('then $DATABASE_URL — what jest.setup.js exports from the worker marker', () => {
        expect(resolveDbUrlFrom({
            ...NONE,
            envVar: 'postgresql://u:p@localhost:5435/from-env',
        })).toBe('postgresql://u:p@localhost:5435/from-env');
    });
});

describe('and then it REFUSES', () => {
    it('throws when nothing supplies a test database', () => {
        expect(() => resolveDbUrlFrom(NONE)).toThrow(/No TEST database is configured/);
    });

    it('names the remedy, not just the problem', () => {
        // A refusal a reader cannot act on is only marginally better than the
        // wrong answer it replaced.
        expect(() => resolveDbUrlFrom(NONE)).toThrow(/db:test:up/);
        expect(() => resolveDbUrlFrom(NONE)).toThrow(/\.env\.test\.example/);
    });

    it('lists what it tried, in order', () => {
        // The failure mode this replaces was a connection error pointing at a
        // port nobody configured on purpose. Printing the chain is what makes
        // the next occurrence diagnosable in one read.
        let msg = '';
        try { resolveDbUrlFrom(NONE); } catch (e) { msg = (e as Error).message; }
        expect(msg).toMatch(/getTestDatabaseUrl/);
        expect(msg).toMatch(/DATABASE_URL_TEST/);
        expect(msg).toMatch(/\.env\.test/);
        expect(msg.indexOf('getTestDatabaseUrl')).toBeLessThan(msg.indexOf('DATABASE_URL_TEST'));
    });

    it('does NOT invent a localhost:5432 guess', () => {
        // Step 5 used to return `postgresql://user:password@localhost:5432/testdb`.
        // A hard-coded URL is the one answer that is wrong on every machine
        // and looks deliberate on all of them.
        let msg = '';
        try { resolveDbUrlFrom(NONE); } catch (e) { msg = (e as Error).message; }
        expect(msg).not.toMatch(/user:password@localhost:5432/);
    });

    it('an EMPTY string is not a configured database', () => {
        // The shape a failed read produces. `''` is falsy, so it must fall
        // through rather than be returned as a URL — a client built on an
        // empty connection string fails far from here.
        expect(() => resolveDbUrlFrom({
            fromHelper: () => '',
            envTestVar: '',
            envTestFile: () => '',
            envVar: '',
        })).toThrow(/No TEST database is configured/);
    });
});
