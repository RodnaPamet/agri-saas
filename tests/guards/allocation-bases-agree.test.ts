/**
 * The cost allocation bases are declared in THREE places and labelled in FOUR.
 * They must agree.
 *
 * ## Why the copies exist
 *
 *   1. `prisma/schema/enums.prisma` — `enum CostAllocationBasis`, what the
 *      database will accept.
 *   2. `src/app-layer/schemas/grain.schemas.ts` — `COST_ALLOCATION_BASES`, the
 *      wire validator and the published contract.
 *   3. `src/app/t/[tenantSlug]/(app)/grain/costs/CostEntryFormModal.tsx` —
 *      `ALLOCATION_BASES`, what the create form offers.
 *
 * The third is NOT redundant, and its own comment gives the reason — the same
 * one `COST_CATEGORY_VALUES` gives: `grain.schemas.ts` imports
 * `@prisma/client`, and pulling the Prisma client into a browser bundle to read
 * three string literals is not a trade worth making.
 *
 * ## Why this guard exists, and why it did not until now
 *
 * This is the identical shape `tests/guards/cost-categories-agree.test.ts` was
 * written for: a list that must be edited in N places silently becomes N-1.
 * That guard exists because adding `CREDIT` and `DEPRECIATION` nearly shipped
 * with the enum and the validator updated and the DROPDOWN not — present
 * everywhere except where a farmer could pick one, with nothing failing.
 *
 * The allocation bases have the same structure and had no guard. The form's own
 * comment even says it mirrors the categories "for the same reason", so the
 * duplication was known and the protection was not carried across.
 *
 * It matters now because #1530 adds a fourth basis. A guard written after the
 * value it is meant to protect is a guard whose first run is already green.
 *
 * ## Four labels, not one
 *
 * The form resolves TWO keys per basis, and one of them unconditionally:
 *
 *     label:       t(`allocationBasis.${value}`)          // per option
 *     description: t(`allocationBasisHint.${watchedBasis}`) // for the SELECTED one
 *
 * So a basis with no `allocationBasisHint` entry renders a raw key as the
 * field's help text the moment a farmer selects it — in both locales. That is
 * two keys × two locales = four, and `i18n-diff --check` cannot catch it: the
 * key is not missing from one locale, it was never added to either.
 *
 * ## Why it reads the .prisma FILE rather than `Prisma.dmmf`
 *
 * Measured on Prisma 7.10.0, immediately after a successful `generate`:
 * `Prisma.dmmf.datamodel.enums` is EMPTY. `models` is populated; enum members
 * are not exposed at all. A guard written against it would compare the wire
 * list against nothing and be green forever — and would look exactly like this
 * file. `node_modules/.prisma` is also not branch-tracked, so it reports
 * whatever the last `generate` produced. The schema file is the branch's own
 * truth.
 */
import * as fs from 'fs';
import * as path from 'path';

import { COST_ALLOCATION_BASES } from '@/app-layer/schemas/grain.schemas';

const ROOT = path.resolve(__dirname, '../..');
const FORM = 'src/app/t/[tenantSlug]/(app)/grain/costs/CostEntryFormModal.tsx';

const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The enum's members, read out of the schema file as text. */
function prismaEnumValues(name: string): string[] {
    const src = read('prisma/schema/enums.prisma');
    const start = src.indexOf(`enum ${name} {`);
    if (start === -1) throw new Error(`enum ${name} not found in enums.prisma`);
    const end = src.indexOf('\n}', start);
    return src
        .slice(start, end)
        .split('\n')
        .slice(1)
        .map((l) => l.trim())
        // Drop the `///` docblocks members may carry.
        .filter((l) => l.length > 0 && !l.startsWith('/'))
        .map((l) => l.split(/\s/)[0]);
}

/**
 * The form's own list, read as TEXT.
 *
 * Importing it is not an option — the module is a client component pulling in
 * the whole form tree — and that is the same reason the duplication exists at
 * all. So the array literal is parsed, and the control below proves the parse
 * found something rather than silently yielding an empty set.
 */
function formBases(): string[] {
    const src = read(FORM);
    const m = /const ALLOCATION_BASES = \[([^\]]*)\]/.exec(src);
    if (m === null) {
        throw new Error(
            `ALLOCATION_BASES literal not found in ${FORM}. If it was renamed or ` +
                `computed, this guard is reading nothing — fix the extractor rather ` +
                `than deleting the assertion.`,
        );
    }
    return [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
}

function messages(locale: 'bg' | 'en'): Record<string, unknown> {
    return JSON.parse(read(`messages/${locale}.json`)) as Record<string, unknown>;
}

/** `grain.costs.form.<group>` for a locale, or `{}`. */
function formGroup(locale: 'bg' | 'en', group: string): Record<string, unknown> {
    const m = messages(locale) as {
        grain?: { costs?: { form?: Record<string, Record<string, unknown>> } };
    };
    return m.grain?.costs?.form?.[group] ?? {};
}

describe('the cost allocation bases agree across every declaration', () => {
    it('control: all three were read and are non-trivial', () => {
        // Without this, every comparison below passes over an empty set —
        // which is agreement, and worthless. Asserted loosely (>= 3) rather
        // than pinned, so adding a basis in all three places stays green.
        expect(prismaEnumValues('CostAllocationBasis').length).toBeGreaterThanOrEqual(3);
        expect(COST_ALLOCATION_BASES.length).toBeGreaterThanOrEqual(3);
        expect(formBases().length).toBeGreaterThanOrEqual(3);
    });

    it('the wire schema matches the database enum, as a SET', () => {
        // Sets, not sequences: Postgres `ADD VALUE` appends, so enum sort order
        // and source order diverge the moment a value is added. Nothing in the
        // product sorts by this enum, so order is not the contract.
        expect(new Set<string>(COST_ALLOCATION_BASES)).toEqual(
            new Set(prismaEnumValues('CostAllocationBasis')),
        );
    });

    it('the form offers exactly what the wire accepts', () => {
        // The direction that nearly shipped broken for the CATEGORIES: a value
        // the wire accepts but the form omits is a basis a farmer cannot
        // choose; one the form offers but the wire rejects 400s on save.
        expect(new Set(formBases())).toEqual(new Set<string>(COST_ALLOCATION_BASES));
    });

    it('names any basis the form cannot offer, rather than just failing', () => {
        // The message is the point: "expected 4 to be 3" sends a reader
        // counting, a named value sends them to the right file.
        const offered = new Set(formBases());
        expect(COST_ALLOCATION_BASES.filter((b) => !offered.has(b))).toEqual([]);
    });

    it.each(['bg', 'en'] as const)('every basis has an OPTION label in %s', (locale) => {
        const labels = formGroup(locale, 'allocationBasis');
        const unlabelled = COST_ALLOCATION_BASES.filter((b) => typeof labels[b] !== 'string');
        expect(unlabelled).toEqual([]);
    });

    it.each(['bg', 'en'] as const)('every basis has a HINT in %s', (locale) => {
        // The form resolves `allocationBasisHint.${watchedBasis}` for whichever
        // basis is SELECTED, unconditionally. A basis with no hint renders a
        // raw key as the field's help text the moment a farmer picks it.
        //
        // `i18n-diff --check` cannot catch this: the key is not missing from
        // one locale, it was never added to either, so key PARITY holds.
        const hints = formGroup(locale, 'allocationBasisHint');
        const unhinted = COST_ALLOCATION_BASES.filter((b) => typeof hints[b] !== 'string');
        expect(unhinted).toEqual([]);
    });

    it('control: the label groups were actually found', () => {
        // Both label assertions above are satisfied by a lookup that returns
        // `{}` for a renamed group — `filter(... typeof !== 'string')` over an
        // empty object is `[]`, which is a pass. So prove the groups exist and
        // are populated before trusting either.
        for (const locale of ['bg', 'en'] as const) {
            expect(Object.keys(formGroup(locale, 'allocationBasis')).length).toBeGreaterThanOrEqual(3);
            expect(
                Object.keys(formGroup(locale, 'allocationBasisHint')).length,
            ).toBeGreaterThanOrEqual(3);
        }
    });
});
