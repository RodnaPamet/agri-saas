/**
 * A probe that did not finish is UNKNOWN, never "absent".
 *
 * `tests/integration/db-helper.ts` decides whether every integration suite
 * runs. It used to read:
 *
 *     return result.status === 0;
 *
 * and `spawnSync` sets `status: null` on a timeout — so a probe that was
 * merely too slow reported "no database", and every integration suite became
 * `describe.skip`. The run got GREENER by running less, which CLAUDE.md names
 * first under "a skipped suite is indistinguishable from a passing one".
 *
 * Measured 2026-09-29: with a mutation sweep holding the box at load ~12, the
 * 30s probe timed out and a new integration suite reported `1 skipped`. The
 * database was up and connected in 1.1s when asked directly.
 *
 * ── Why this test does not spawn anything ──
 *
 * The bug only appears when the machine is too busy to answer in time. A test
 * that had to spawn a process and wait would be subject to the same load it
 * is testing for — it would be flaky in exactly the conditions that matter,
 * and green in the conditions that do not. So the classification is a pure
 * function and this exercises it directly.
 */
import { classifyProbe, type DbProbeOutcome } from '../integration/db-probe';

describe('classifyProbe — three outcomes, not two', () => {
    it('exit 0 is available', () => {
        expect(classifyProbe({ status: 0 })).toBe<DbProbeOutcome>('ok');
    });

    it('exit 1 is a real refusal — the probe finished and said no', () => {
        // The probe script exits 1 from its own `.catch`, so this is an
        // ANSWER: there is no database. Skipping here is correct.
        expect(classifyProbe({ status: 1 })).toBe<DbProbeOutcome>('refused');
    });

    it('a TIMEOUT is unknown, not absent — this is the bug', () => {
        // `spawnSync` on timeout: status null, signal SIGTERM, error ETIMEDOUT.
        // The old `status === 0` test made this false, and false meant
        // "absent". It is the single line this whole change exists for.
        const timedOut = {
            status: null,
            signal: 'SIGTERM' as NodeJS.Signals,
            error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }),
        };
        expect(classifyProbe(timedOut)).toBe<DbProbeOutcome>('unknown');
        expect(classifyProbe(timedOut)).not.toBe<DbProbeOutcome>('refused');
    });

    it('a signalled probe is unknown', () => {
        // A sweep, an OOM killer or a Ctrl-C can take the child. None of
        // those is evidence about Postgres.
        expect(classifyProbe({ status: null, signal: 'SIGKILL' as NodeJS.Signals })).toBe(
            'unknown',
        );
    });

    it('a spawn failure is unknown', () => {
        // `node` missing from PATH says nothing about the database either.
        expect(
            classifyProbe({ status: null, error: new Error('spawn node ENOENT') }),
        ).toBe<DbProbeOutcome>('unknown');
    });

    it('an unexpected non-zero exit is unknown, not refused', () => {
        // Only exit 1 is the script's own "cannot connect". Anything else —
        // a Node crash, an OOM exit, a module-resolution failure — is the
        // probe breaking, and must not be read as an answer about the DB.
        // Getting this wrong is how a broken probe silently disables a suite.
        for (const status of [2, 7, 127, 134, 139]) {
            expect(classifyProbe({ status })).toBe<DbProbeOutcome>('unknown');
        }
    });

    it('the three outcomes are distinguishable from each other', () => {
        // Guards against a future "simplification" that collapses two of
        // them back together — which is precisely what the old code did.
        const outcomes = new Set([
            classifyProbe({ status: 0 }),
            classifyProbe({ status: 1 }),
            classifyProbe({ status: null, signal: 'SIGTERM' as NodeJS.Signals }),
        ]);
        expect(outcomes.size).toBe(3);
    });
});
