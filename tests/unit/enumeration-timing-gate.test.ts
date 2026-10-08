/**
 * The enumeration-timing gate EXECUTES, and it can express failure (#1411).
 *
 * ## Why this runs the script as a subprocess
 *
 * `scripts/check-enumeration-timing.mjs` decides whether a security gate
 * passes, and what CI depends on is its EXIT CODE. So every case here spawns
 * the real CLI and asserts on the status, exactly as
 * `tests/unit/coverage-tooling/coverage-scripts.test.ts` does for the coverage
 * scripts — importing the functions would skip the file read, the parse and
 * the exit code, which is three of the four things that can go wrong.
 *
 * ## Why an executing test and not a guard
 *
 * This repo has shipped the other arrangement. The coverage gate was 675
 * lines deciding whether CI passed, every test naming it asserted source
 * TEXT, and neutering both its seams at once left 28 of 28 tests green. A
 * script that decides a gate needs a test that runs it.
 *
 * ## The failures that must not read as passes
 *
 * An ABSENT branch median computes a separation of zero if you let it, and
 * zero passes a band. An unreadable results file says nothing about the
 * property. Both are the instrument failing rather than the property holding,
 * and both are pinned below.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-enumeration-timing.mjs');

let tmp: string;
beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'enum-gate-'));
});
afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
});

/** Write a k6-shaped results file and return its path. */
function results(
    medians: { new?: number | null; pending?: number | null; taken?: number | null },
    opts: {
        mismatches?: number;
        name?: string;
        /** The paired-spread dispersion, for the old-vs-new comparison in §6. */
        spread?: { med?: number; 'p(95)'?: number; max?: number };
    } = {},
): string {
    const m: Record<string, unknown> = {
        enum_shape_mismatch: { values: { count: opts.mismatches ?? 0 } },
    };
    if (opts.spread) m.enum_paired_spread_ms = { values: opts.spread };
    const put = (key: string, v: number | null | undefined) => {
        if (v !== undefined) m[key] = { values: { med: v } };
    };
    put('enum_branch_new_ms', medians.new);
    put('enum_branch_pending_ms', medians.pending);
    put('enum_branch_taken_ms', medians.taken);
    const file = path.join(tmp, `${opts.name ?? Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify({ metrics: m }));
    return file;
}

function run(file: string, band = '50') {
    const r = spawnSync('node', [SCRIPT, file], {
        encoding: 'utf8',
        env: { ...process.env, MAX_SPREAD_MS: band },
    });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('§1 the run that reddened main would now PASS', () => {
    it('330.2 / 326.1 / 326.0 — 4.2ms apart — exits 0 on a 50ms band', () => {
        // The real figures from main 66688b0a1, where the old p(95) gate
        // failed at 78.4ms against this same band while the property held and
        // shape mismatches were zero.
        const r = run(results({ new: 330.2, pending: 326.1, taken: 326.0 }));
        expect(r.status).toBe(0);
        expect(r.out).toMatch(/median separation\s+: 4\.2 ms\s+\(band 50 ms\)/);
        expect(r.out).toMatch(/verdict\s+: PASS/);
    });
});

describe('§2 and the defect it exists to catch still FAILS', () => {
    it('a branch skipping hashPassword is ~330ms out and exits 1', () => {
        const r = run(results({ new: 330.2, pending: 326.1, taken: 0 }));
        expect(r.status).toBe(1);
        expect(r.out).toMatch(/median separation 330\.2 ms is outside the 50 ms band/);
        // The message has to say what to look at, or a red gate is a puzzle.
        expect(r.out).toMatch(/hashPassword still runs on EVERY branch/);
    });

    it('a separation exactly AT the band is refused, not admitted', () => {
        // `>=`, not `>`. A boundary that admits the band is a gate one
        // rounding error wide of useless.
        const r = run(results({ new: 350, pending: 325, taken: 300 }));
        expect(r.status).toBe(1);
        expect(r.out).toMatch(/50\.0 ms is outside/);
    });

    it('the healthy-to-broken margin is wide, not marginal', () => {
        // 4.2ms healthy vs 330ms broken on a 50ms band: ~12x headroom one way
        // and ~6.6x over the other. The statistic it replaced read 78.4
        // against 50 — failing, on the HEALTHY side.
        expect(run(results({ new: 330.2, pending: 326.1, taken: 326.0 })).status).toBe(0);
        expect(run(results({ new: 330.2, pending: 326.1, taken: 326.0 }), '5').status).toBe(0);
        expect(run(results({ new: 330.2, pending: 326.1, taken: 0 }), '300').status).toBe(1);
    });
});

describe('§3 absence is never a pass — the defect class this repo ships most', () => {
    it.each([
        ['branch A absent', { pending: 326.1, taken: 326.0 }],
        ['branch B absent', { new: 330.2, taken: 326.0 }],
        ['branch C absent', { new: 330.2, pending: 326.1 }],
        ['all three absent', {}],
    ])('%s → exit 1, not a separation of zero', (_label, medians) => {
        const r = run(results(medians));
        expect(r.status).toBe(1);
        expect(r.out).toMatch(/absent or non-finite/);
        // The tell: a naive max-minus-min over the present values would have
        // produced a small number here and passed.
        expect(r.out).toMatch(/ABSENT/);
        expect(r.out).not.toMatch(/verdict\s+: PASS/);
    });

    it('a null median is absence, not a value of zero', () => {
        const r = run(results({ new: null, pending: 326.1, taken: 326.0 }));
        expect(r.status).toBe(1);
    });

    it('an unreadable results file is the INSTRUMENT failing, and exits 1', () => {
        // A missing file is what a k6 run that died looks like. Reporting it
        // as a pass is how a gate goes dark while reading green.
        const r = run(path.join(tmp, 'does-not-exist.json'));
        expect(r.status).toBe(1);
        expect(r.out).toMatch(/could not read/);
        expect(r.out).toMatch(/means the run did not finish, not that the property holds/);
    });

    it('a results file that is not JSON exits 1', () => {
        const f = path.join(tmp, 'garbage.json');
        writeFileSync(f, 'not json at all');
        expect(run(f).status).toBe(1);
    });
});

describe('§4 a broken uniformity makes the timing beside the point', () => {
    it('a shape mismatch exits 1 even when the medians are tight', () => {
        // k6 gates this at 0 too. Re-checked here so the script fails on its
        // own rather than passing a run whose uniformity had already broken —
        // differing responses are a louder oracle than differing timing.
        const r = run(results({ new: 330.2, pending: 326.1, taken: 326.0 }, { mismatches: 3 }));
        expect(r.status).toBe(1);
        expect(r.out).toMatch(/byte-identical/);
    });
});

describe('§5 the band is configurable and honoured', () => {
    it('MAX_SPREAD_MS moves the gate, and is printed so a reader sees which band ran', () => {
        const file = results({ new: 400, pending: 350, taken: 340 });
        expect(run(file, '100').status).toBe(0);
        expect(run(file, '50').status).toBe(1);
        expect(run(file, '100').out).toMatch(/\(band 100 ms\)/);
    });
});

describe('§6 the change does what it CLAIMS — the old statistic must fail where the new one passes', () => {
    /**
     * The assertion the rest of this file does not make, and the one that
     * justifies #1411 rather than merely passing after it.
     *
     * Every test above shows the NEW statistic behaving correctly. None of
     * them shows that the OLD statistic was wrong — and a change that only
     * demonstrates "the new thing is green" is the same shape as a check that
     * passes while verifying nothing, one level up. What makes this a fix
     * rather than a preference is that on the real data from main
     * `66688b0a1`, the two statistics DISAGREE: the property held, the new
     * gate says so, the old gate did not.
     *
     * Raised by backend-1, who pointed out that running k6 on this PR would
     * have told us the new statistic passes and could never have told us it
     * can still fail.
     */
    const BAND = 50;

    /** The real figures from the run that reddened main. */
    const PRODUCTION_SHAPE = {
        medians: { new: 330.2, pending: 326.1, taken: 326.0 },
        spread: { med: 21.4, 'p(95)': 78.4, max: 267.5 },
    };

    it('on the real red-run data, the NEW gate passes', () => {
        const r = run(results(PRODUCTION_SHAPE.medians, { spread: PRODUCTION_SHAPE.spread }));
        expect(r.status).toBe(0);
        expect(r.out).toMatch(/median separation\s+: 4\.2 ms/);
    });

    it('…and the OLD gate, p(95) of the per-trial |Δ|, would have FAILED on it', () => {
        // Not run through the script — the old statistic is gone from it. This
        // is the arithmetic the old k6 threshold did, stated against the same
        // fixture, so the disagreement is in the test rather than only in a
        // commit message.
        const oldStatistic = PRODUCTION_SHAPE.spread['p(95)'];
        expect(oldStatistic).toBeGreaterThanOrEqual(BAND); // 78.4 >= 50 → red

        const newStatistic =
            Math.max(...Object.values(PRODUCTION_SHAPE.medians)) -
            Math.min(...Object.values(PRODUCTION_SHAPE.medians));
        expect(newStatistic).toBeLessThan(BAND); // 4.2 < 50 → green

        // The point: one dataset, two verdicts. That is what makes this a fix.
        expect(oldStatistic > BAND && newStatistic < BAND).toBe(true);
    });

    it('a genuine leak with LOW jitter fails the new gate — so it is not `return true`', () => {
        // The complement of the case above, and the one that stops the new
        // statistic being satisfied by anything. Medians 80ms apart with a
        // tight spread: no noise to hide behind, a real timing oracle.
        const r = run(
            results(
                { new: 410.0, pending: 330.0, taken: 328.0 },
                { spread: { med: 2.1, 'p(95)': 4.0, max: 6.2 } },
            ),
        );
        expect(r.status).toBe(1);
        expect(r.out).toMatch(/82\.0 ms is outside the 50 ms band/);
    });

    it('…which the OLD gate would have MISSED, because the jitter was low', () => {
        // The inverse failure, and the reason the old statistic was not merely
        // noisy but aimed wrong: p(95) of 4.0ms sails under a 50ms band while
        // the branches are 82ms apart. The old gate was simultaneously too
        // loud on healthy data AND blind to a low-jitter leak.
        const leakSpread = { med: 2.1, 'p(95)': 4.0, max: 6.2 };
        expect(leakSpread['p(95)']).toBeLessThan(BAND); // the old gate: green
        expect(410.0 - 328.0).toBeGreaterThanOrEqual(BAND); // the new gate: red
    });
});

