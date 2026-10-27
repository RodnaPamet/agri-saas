/**
 * The cost form and the contract form must not share a currency source — #2398.
 *
 * ## The asymmetry, which is the whole reason this is delicate
 *
 * Costs are euro-only. Grain contracts are NOT: grain here is genuinely
 * contracted in USD, RON and PLN, so `ContractFormModal` must keep all twelve
 * `CONTRACT_CURRENCIES`. The two surfaces therefore need DIFFERENT answers from
 * the same module, and the tempting fix — narrowing `currencyOptions` itself —
 * would quietly break contract pricing while every cost test went green.
 *
 * That is why the change belonged in the cost form and not in the shared
 * helper, and why this guard asserts the separation rather than trusting the
 * note in #2398 to be read.
 *
 * ## It is a both-branches check by construction
 *
 * A guard asserting only "the cost surface does not import `currencyOptions`"
 * passes trivially the day `currencyOptions` is deleted, renamed, or stops
 * being imported anywhere — the population empties and the assertion holds over
 * nothing. #2377's lesson applies directly: a non-empty population is not
 * enough either, it has to have a member on BOTH sides of the partition.
 *
 * So the positive half is load-bearing: the contract form MUST still be a
 * consumer. One file on each side, derived rather than asserted by name alone.
 */
import { readFileSync } from 'fs';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles } from '../helpers/collect-files';

const REPO_ROOT = process.cwd();

/** The euro-only surface. Nothing under here may offer a currency choice. */
const COST_SURFACE = 'src/app/t/[tenantSlug]/(app)/grain/costs';

/** The multi-currency surface, which must stay a consumer. */
const CONTRACT_FORM = 'src/app/t/[tenantSlug]/(app)/grain/contracts/ContractFormModal.tsx';

/**
 * The exports that offer a CHOICE of currency. `isStoredAsEuro`,
 * `normaliseCostToEur` and `allResolveToEur` are deliberately NOT here — they
 * answer questions about a currency rather than offering a menu of them, and
 * the cost form is supposed to use the first.
 */
const CHOICE_EXPORTS = ['currencyOptions', 'CONTRACT_CURRENCIES'];

export function offersACurrencyChoice(source: string): boolean {
    const code = blankNonCode(source);
    // Must be an actual import FROM the currencies module — the bare word
    // appears in prose and in this guard's own docblock, and matching that
    // would make every file that merely discusses the subject an offender.
    const imports = [...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*grain\/currencies['"]/g)]
        .flatMap((m) => m[1].split(',').map((x) => x.trim()));
    return CHOICE_EXPORTS.some((e) => imports.includes(e));
}

function consumers(): string[] {
    const files = collectSourceFiles({
        roots: ['src'],
        extensions: ['.ts', '.tsx'],
        // ~1,900 source files; a floor far below it separates "nobody offers a
        // choice" from "nothing was read".
        floor: 200,
    });
    return files
        .map((abs) => abs.slice(REPO_ROOT.length + 1))
        .filter((rel) => offersACurrencyChoice(readFileSync(rel, 'utf8')))
        .sort();
}

const CONSUMERS = consumers();

describe('cost and contract currency sources stay separate (#2398)', () => {
    it('[currency-sources] ranges over a real population — BOTH sides', () => {
        console.log(
            `[currency-sources] ${CONSUMERS.length} file(s) offer a currency choice: `
                + CONSUMERS.join(', '),
        );
        // The positive half. Without it this guard passes for free the moment
        // `currencyOptions` stops being imported anywhere at all.
        expect(CONSUMERS).toContain(CONTRACT_FORM);
        expect(CONSUMERS.length).toBeGreaterThanOrEqual(1);
    });

    it('nothing under the COSTS surface offers a currency choice', () => {
        const offenders = CONSUMERS.filter((f) => f.startsWith(COST_SURFACE));
        expect(offenders).toEqual([]);
    });

    it('the cost form asks whether a currency IS euro, rather than offering a menu', () => {
        // The replacement, named. A cost form with neither the menu nor the
        // predicate would pass the test above while having lost the rule.
        const form = readFileSync(`${COST_SURFACE}/CostEntryFormModal.tsx`, 'utf8');
        expect(blankNonCode(form)).toMatch(/isStoredAsEuro/);
    });

    it('the contract form still offers all twelve, because grain really is foreign-priced', () => {
        const contract = blankNonCode(readFileSync(CONTRACT_FORM, 'utf8'));
        expect(contract).toMatch(/currencyOptions/);
    });
});

describe('the detector itself', () => {
    it('flags an import of the choice helper', () => {
        expect(
            offersACurrencyChoice("import { currencyOptions } from '@/lib/grain/currencies';"),
        ).toBe(true);
        expect(
            offersACurrencyChoice("import { CONTRACT_CURRENCIES } from '@/lib/grain/currencies';"),
        ).toBe(true);
    });

    it('does NOT flag the predicates, which the cost form is meant to use', () => {
        expect(
            offersACurrencyChoice("import { isStoredAsEuro } from '@/lib/grain/currencies';"),
        ).toBe(false);
        expect(
            offersACurrencyChoice(
                "import { normaliseCostToEur, allResolveToEur } from '@/lib/grain/currencies';",
            ),
        ).toBe(false);
    });

    it('does not flag a file that merely MENTIONS the helper', () => {
        // Including in a comment, which is why the source is blanked first —
        // otherwise a note explaining the removal would read as the removal
        // being undone.
        expect(offersACurrencyChoice('// currencyOptions is deliberately not used here')).toBe(false);
        expect(offersACurrencyChoice('const s = "currencyOptions";')).toBe(false);
        expect(
            offersACurrencyChoice("/* import { currencyOptions } from '@/lib/grain/currencies'; */"),
        ).toBe(false);
    });

    it('does not flag an import of the same NAME from somewhere else', () => {
        // A `currencyOptions` from an unrelated module is not this rule's
        // business, and matching it would make the guard wrong about a file it
        // has no opinion on.
        expect(offersACurrencyChoice("import { currencyOptions } from './local-helpers';")).toBe(false);
    });

    it('flags it among several imports, not only alone', () => {
        expect(
            offersACurrencyChoice(
                "import { isStoredAsEuro, currencyOptions } from '@/lib/grain/currencies';",
            ),
        ).toBe(true);
    });
});
