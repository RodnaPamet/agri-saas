/**
 * The coverage gate must stay DIAGNOSABLE.
 *
 * Background — a failure mode that cost real time. Jest removes a file from
 * the `global` threshold group as soon as that file matches a PATH
 * threshold. `jest.thresholds.json` declares paths for
 * `./src/app-layer/{usecases,policies,events}/` and `./src/lib/`, so the
 * `global` numbers are computed over EVERYTHING ELSE — chiefly
 * `src/components/**`, `src/app/**`, and the rest of `src/app-layer/**`.
 *
 * The result is a run that prints one number and fails on another:
 *
 *     Coverage summary  ->  Branches : 66.54% ( 27730/41670 )   <- whole map
 *     Jest: Coverage for branches (59.94%) does not meet
 *           "global" threshold (63%)                            <- global group
 *
 * Both are correct; they are different populations. Reconciling them needs
 * PER-FILE data, and `lcov` alone is awkward to attribute while
 * `text-summary` has no per-file breakdown at all. Without
 * `coverage-summary.json` the honest answer to "which files should I test?"
 * is unavailable — and work lands on files that cannot move the failing
 * number (covering something under `src/lib/` improves the `./src/lib/`
 * threshold and leaves `global` untouched).
 *
 * These assertions are deliberately about OBSERVABILITY, not about coverage
 * levels. They keep the gate explainable; they do not police its value.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');

describe('coverage gate diagnosability', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const jestConfig = require('../../jest.config.js');

    it('emits json-summary so a threshold failure can be attributed to files', () => {
        expect(jestConfig.coverageReporters).toContain('json-summary');
    });

    it('keeps the human-readable and machine-readable reporters alongside it', () => {
        expect(jestConfig.coverageReporters).toEqual(
            expect.arrayContaining(['text-summary', 'lcov']),
        );
    });

    it('documents the global-group carve-out where a reader will hit it', () => {
        // The trap is invisible in the failure message itself, so the
        // explanation has to live next to the config that causes it.
        const cfg = fs.readFileSync(path.join(ROOT, 'jest.config.js'), 'utf8');
        expect(cfg).toMatch(/PATH threshold/i);
        expect(cfg).toMatch(/global/);

        const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
        expect(ci).toMatch(/coverage-summary\.json/);
    });

    it('every path threshold is a real directory — a typo silently widens `global`', () => {
        // A path that matches nothing claims no files, so those files stay
        // in `global` and the intended per-area floor never applies. Nothing
        // else in the stack reports that.
        const thresholds = JSON.parse(
            fs.readFileSync(path.join(ROOT, 'jest.thresholds.json'), 'utf8'),
        ) as Record<string, unknown>;

        const paths = Object.keys(thresholds).filter((k) => k !== 'global');
        expect(paths.length).toBeGreaterThan(0);

        for (const p of paths) {
            const rel = p.replace(/^\.\//, '').replace(/\/$/, '');
            expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
        }
    });

    it('the global floor stays meaningful — a path threshold cannot cover the whole tree', () => {
        // If someone added a `./src/` path threshold, `global` would be
        // emptied and the gate would pass on nothing at all.
        const thresholds = JSON.parse(
            fs.readFileSync(path.join(ROOT, 'jest.thresholds.json'), 'utf8'),
        ) as Record<string, unknown>;

        for (const p of Object.keys(thresholds)) {
            if (p === 'global') continue;
            const rel = p.replace(/^\.\//, '').replace(/\/$/, '');
            expect(['src', 'src/app-layer', 'src/components', 'src/app']).not.toContain(rel);
        }
    });
});
