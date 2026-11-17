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
 * THAT CHANGE IS NOW RULED OUT (owner, 2026-11-16): the figures stay reference
 * data in the calendar, with no «Нов разход» suggestion, because the calculator
 * has no vineyard crop, «Материали…» combines plant protection with
 * fertilisers, and the wage lines are farm-wide salaries. So this guard is not
 * redundant — it is STRONGER. An import outside the allowed subtree now
 * contradicts an explicit decision rather than a risk somebody foresaw, and
 * the ruling is the kind that gets revisited, so the fence should outlast it.
 *
 * So: the import is allowed in exactly one subtree, and the farm-money paths
 * are asserted clean by name as well as by pattern.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

/**
 * The only subtrees that may convert a published lev figure.
 *
 * The calendar (МЗХ technology cards, #637) and, since agrent-ios#638, the
 * benchmarks: МЗХ's coupled-support rates, which the order prints in leva per
 * hectare. Same ruling, applied by the owner on 2026-11-17 ("convert, mark
 * it", as the vine card): a ministry document's figure shown in euro, never
 * the farm's own money.
 */
const ALLOWED_PREFIXES: readonly string[] = ['src/lib/agro/calendar/', 'src/lib/agro/benchmarks/'];

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
const IMPORTS_PEG = /import\s*\{[^}]*\b(?:BGN_PER_EUR|perDaEurCents)\b[^}]*\}\s*from/;

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

    it('[calendar-peg] nothing outside the allowed subtrees imports the peg or its converter', () => {
        /*
         * The population was ZERO while this matched `BGN_PER_EUR` alone —
         * nothing imports the constant; the loaders take `perDaEurCents`. That
         * hid a hole: a converter import is a conversion all the same, and the
         * detector could not see one. It matches both names since
         * agrent-ios#638, so the calendar and benchmarks loaders are a live
         * positive. (The first version also matched its own docblock prose
         * through `[^;]*`; the crafted self-test below pins that it cannot.)
         */
        const importers = FILES.map((abs) => ({
            rel: path.relative(REPO_ROOT, abs).split(path.sep).join('/'),
            code: blankComments(fs.readFileSync(abs, 'utf8')),
        }))
            .filter(({ code }) => IMPORTS_PEG.test(code))
            .map(({ rel }) => rel);
        console.log(`[calendar-peg] ${importers.length} importer(s): ${importers.join(', ') || 'none'}`);
        expect(importers.filter((r) => !ALLOWED_PREFIXES.some((p) => r.startsWith(p)))).toEqual([]);
        // The converter IS imported now (calendar + benchmarks loaders), so the
        // detector has a live positive as well as the crafted one below.
        expect(importers.length).toBeGreaterThanOrEqual(2);
    });

    it('SELF-TEST: the detector finds a real import and ignores the prose', () => {
        // The population above is empty, so this is what gives it any power.
        expect(IMPORTS_PEG.test(blankComments(
            "import { BGN_PER_EUR } from '@/lib/agro/calendar/costs';\nconst x = 1;",
        ))).toBe(true);
        expect(IMPORTS_PEG.test(blankComments(
            "import { perDaEurCents, BGN_PER_EUR } from './costs';",
        ))).toBe(true);
        expect(IMPORTS_PEG.test(blankComments(
            "import { perDaEurCents } from '../calendar/costs';",
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
