/**
 * The lev peg is scoped to PUBLISHED reference figures, and nothing else may
 * import it — #637.
 *
 * ## Why a guard rather than a comment
 *
 * `1.95583` was removed from this codebase on purpose. #2793 took it out of
 * four places on the owner's 2026-11-08 ruling — the cost rollup, rent basis,
 * rent units and the lease path — so `normaliseCostToEur` answers a `BGN`
 * amount with `refusal: 'FOREIGN'`, `COST_ENTRY_CURRENCY_NOT_EUR` refuses a
 * non-euro cost on write, and a lev lease is refused too.
 *
 * The owner's 2026-11-16 ruling re-admits a peg for ONE purpose: converting
 * МЗХ's published technology-card figures for display. Those are not the
 * farm's money — nobody entered them, they describe a ministry document, and
 * their traceability is the PDF.
 *
 * That distinction is the whole of why re-adding the constant is safe, and a
 * distinction maintained only by a docblock is one that expires silently. The
 * obvious future change is somebody wiring these figures into the cost form as
 * a default and reaching for the nearest conversion — which is this one. At
 * that moment the farm's own money would be converted at a peg four other
 * modules say was deleted, and nothing would fail.
 *
 * So: the import is allowed in exactly one subtree, and the farm-money paths
 * are asserted clean by name as well as by pattern.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

/** The only subtree that may convert a published lev figure. */
const ALLOWED_PREFIX = 'src/lib/agro/calendar/';

/**
 * Paths that refuse lev and must therefore never hold a rate — named
 * individually, because a pattern would not say WHY each one matters and a
 * renamed file should fail loudly rather than drop out of the population.
 */
const FARM_MONEY_FILES: readonly string[] = [
    'src/lib/grain/currencies.ts',
    'src/lib/grain/rent-basis.ts',
    'src/lib/agro/rent-units.ts',
    'src/lib/exchange/currency.ts',
];

/**
 * An ES import whose named bindings include the peg.
 *
 * Anchored on `from` so it cannot run off the end of a statement into
 * unrelated code, and `[^}]*` cannot cross the closing brace — which is what
 * let the first version's `[^;]*` swallow a whole docblock.
 */
const IMPORTS_PEG = /import\s*\{[^}]*\bBGN_PER_EUR\b[^}]*\}\s*from/;

/**
 * Comments blanked, because all five files DISCUSS the peg at length.
 *
 * The SHARED helper, not a local regex. A hand-rolled stripper here was
 * block-first, which `comment-stripper-order` refuses for #1497's reason: a
 * line comment containing `/*` opens a fake block and swallows the code after
 * it. `strings: false` keeps string literals, because an import specifier is
 * one and the detector reads it.
 */
const blankComments = (src: string): string => blankNonCode(src, { strings: false });

const FILES = collectSourceFiles({
    roots: ['src'],
    extensions: ['.ts', '.tsx'],
});

describe('the calendar peg stays out of the farm\'s money (#637)', () => {
    it('[calendar-peg] the scan found a real population', () => {
        console.log(`[calendar-peg] ${FILES.length} source file(s) scanned`);
        expect(FILES.length).toBeGreaterThan(1500);
    });

    it('every named farm-money file still exists', () => {
        // A renamed file would silently leave the population below, and the
        // absence would read as a pass.
        for (const rel of FARM_MONEY_FILES) {
            expect({ rel, exists: fs.existsSync(path.join(REPO_ROOT, rel)) })
                .toEqual({ rel, exists: true });
        }
    });

    it('[calendar-peg] nothing outside the calendar subtree imports BGN_PER_EUR', () => {
        /*
         * THE POPULATION IS LEGITIMATELY ZERO TODAY, and the first version of
         * this test hid that behind a bug worth recording.
         *
         * It matched `/\bimport\b[^;]*\bBGN_PER_EUR\b/` against the RAW
         * source and reported one importer: `costs.ts`, the file that
         * DECLARES the constant and imports nothing at all. The match was on
         * its docblock — "Do not import this into a cost, lease or contract
         * path" — with `[^;]*` spanning the prose. So a comment satisfied the
         * "it IS imported somewhere" control, which would then have passed
         * whether or not the detector could see a real import.
         *
         * Nothing imports `BGN_PER_EUR`: `load.ts` takes `perDaEurCents`, and
         * the rate stays inside the module that owns it. That is the desired
         * state, so there is nothing live to assert against — and an empty
         * population needs its detector proved on a crafted input instead,
         * which is the next test.
         */
        const importers = FILES.map((abs) => ({
            rel: path.relative(REPO_ROOT, abs).split(path.sep).join('/'),
            code: blankComments(fs.readFileSync(abs, 'utf8')),
        }))
            .filter(({ code }) => IMPORTS_PEG.test(code))
            .map(({ rel }) => rel);
        console.log(`[calendar-peg] ${importers.length} importer(s): ${importers.join(', ') || 'none'}`);
        expect(importers.filter((r) => !r.startsWith(ALLOWED_PREFIX))).toEqual([]);
    });

    it('SELF-TEST: the detector finds a real import and ignores the prose', () => {
        // The population above is empty, so this is what gives it any power.
        expect(IMPORTS_PEG.test(blankComments(
            "import { BGN_PER_EUR } from '@/lib/agro/calendar/costs';\nconst x = 1;",
        ))).toBe(true);
        expect(IMPORTS_PEG.test(blankComments(
            "import { perDaEurCents, BGN_PER_EUR } from './costs';",
        ))).toBe(true);
        // ...and the sentence that fooled the first version does not match.
        expect(IMPORTS_PEG.test(blankComments(
            '/** Do not import this into a cost path. */\nexport const BGN_PER_EUR = 1.95583;',
        ))).toBe(false);
    });

    it('no farm-money file carries a numeric lev rate at all', () => {
        // Stronger than the import check for these four: a hand-written
        // `/ 1.95583` needs no import. Comments are blanked first, because all
        // four DISCUSS the removed peg at length and the prose is not the
        // mechanism — that is the `a-scar-is-not-a-wound` rule.
        const offenders: string[] = [];
        for (const rel of FARM_MONEY_FILES) {
            const raw = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
            const code = blankComments(raw);
            if (/1\.95583/.test(code)) offenders.push(rel);
        }
        expect(offenders).toEqual([]);
    });

    it('SELF-TEST: the comment stripper does not blank the code it must read', () => {
        // The four files above pass partly because their mentions are in
        // comments. If the stripper were over-eager it would blank real code
        // too and the assertion would pass over nothing.
        const sample = fs.readFileSync(
            path.join(REPO_ROOT, 'src/lib/agro/calendar/costs.ts'),
            'utf8',
        );
        const code = blankComments(sample);
        // The real declaration survives stripping...
        expect(code).toMatch(/export const BGN_PER_EUR = 1\.95583;/);
        // ...and the docblock's prose does not.
        expect(code).not.toMatch(/published reference figures BY INTENT/);
    });
});
