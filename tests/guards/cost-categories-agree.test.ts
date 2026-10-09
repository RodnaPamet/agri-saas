/**
 * The cost categories are declared THREE times. They must agree.
 *
 * ## Why three copies exist
 *
 *   1. `prisma/schema/enums.prisma` — `enum CostCategory`, what the database
 *      will accept.
 *   2. `src/app-layer/schemas/grain.schemas.ts` — `COST_CATEGORIES`, the wire
 *      validator and the published contract.
 *   3. `src/app/t/[tenantSlug]/(app)/grain/costs/filter-defs.ts` —
 *      `COST_CATEGORY_VALUES`, what the create form and the filter facet offer.
 *
 * The third is NOT redundant and should not be de-duplicated. Its own comment
 * gives the reason, and it is sound: `grain.schemas.ts` imports
 * `@prisma/client`, and pulling the Prisma client into a browser bundle to read
 * string literals is not a trade worth making.
 *
 * ## The defect this exists for, which nearly shipped
 *
 * Adding `CREDIT` and `DEPRECIATION` for the «Нов разход» overhead sheet meant
 * editing (1) and (2). I had both done and the migration verified against the
 * real database before noticing (3) — which would have put the two categories
 * in the database and on the API while leaving them **invisible in the web
 * UI**. Present everywhere except where a farmer could pick one, and nothing
 * would have failed: the enum accepts them, the validator accepts them, and the
 * dropdown simply does not offer them.
 *
 * That is the same shape as a tag with no label and a spec field with no
 * projection: a list that must be edited in N places silently becomes N-1.
 *
 * ## Why it reads the .prisma FILE rather than `Prisma.dmmf`
 *
 * Two reasons, and the second is the decisive one.
 *
 * `node_modules/.prisma` is not branch-tracked, so `Prisma.dmmf` reports
 * whatever the last `prisma generate` produced — on a different branch, that is
 * a different enum.
 *
 * And measured on Prisma 7.10.0, immediately after a successful `generate`:
 *
 *     dmmf top keys:   datamodel
 *     datamodel keys:  models,enums,types
 *     enums count:     0
 *
 * The `enums` array is EMPTY. `models` is populated — `amountPerDca` is
 * visible on `CostEntry` — but enum members are not exposed at all. So a guard
 * written against `Prisma.dmmf.datamodel.enums` would compare the wire list
 * against nothing, find no disagreement, and be green forever. It would also
 * look exactly like this file.
 *
 * The schema file is the branch's own truth, and the real database is the
 * final one: the migration was verified with a `pg_enum` query showing all ten
 * values present, which is the check no test can make.
 */
import * as fs from 'fs';
import * as path from 'path';
import { COST_CATEGORIES } from '@/app-layer/schemas/grain.schemas';
import { COST_CATEGORY_VALUES } from '@/app/t/[tenantSlug]/(app)/grain/costs/filter-defs';

const ROOT = path.resolve(__dirname, '../..');

/** The enum's members, read out of the schema file as text. */
function prismaEnumValues(name: string): string[] {
    const src = fs.readFileSync(path.join(ROOT, 'prisma/schema/enums.prisma'), 'utf8');
    const start = src.indexOf(`enum ${name} {`);
    if (start === -1) throw new Error(`enum ${name} not found in enums.prisma`);
    const end = src.indexOf('\n}', start);
    const body = src.slice(start, end);
    return body
        .split('\n')
        .slice(1)
        .map((l) => l.trim())
        // Drop the `///` docblocks the new members carry.
        .filter((l) => l.length > 0 && !l.startsWith('/'))
        .map((l) => l.split(/\s/)[0]);
}

describe('the three cost-category declarations agree', () => {
    it('control: all three were read and are non-trivial', () => {
        // Without this, a renamed enum or a broken import makes every
        // comparison below pass over an empty set — which is agreement, and
        // worthless. The counts are asserted loosely (>= 8) rather than pinned
        // to 10, so adding a category in all three places stays a green diff.
        expect(prismaEnumValues('CostCategory').length).toBeGreaterThanOrEqual(8);
        expect(COST_CATEGORIES.length).toBeGreaterThanOrEqual(8);
        expect(COST_CATEGORY_VALUES.length).toBeGreaterThanOrEqual(8);
    });

    it('the wire schema matches the database enum, as a SET', () => {
        // Sets, not sequences: Postgres `ADD VALUE` appends, so the database's
        // enum sort order is `… SERVICE OTHER CREDIT DEPRECIATION` while the
        // .prisma file lists the new pair before OTHER. Nothing in the product
        // sorts by the enum — verified — so order is not the contract here and
        // asserting it would fail for a difference that cannot be observed.
        expect(new Set(COST_CATEGORIES)).toEqual(new Set(prismaEnumValues('CostCategory')));
    });

    it('the web UI offers exactly what the wire accepts', () => {
        // The direction that nearly shipped broken. A value the wire accepts
        // but the UI omits is a category a farmer cannot choose; one the UI
        // offers but the wire rejects is a dropdown entry that 400s on save.
        expect(new Set(COST_CATEGORY_VALUES)).toEqual(new Set(COST_CATEGORIES));
    });

    it('names any category the UI cannot offer, rather than just failing', () => {
        // The failure message is the point: "expected 10 to be 9" sends a
        // reader counting, while a named value sends them to the right file.
        const offered = new Set<string>(COST_CATEGORY_VALUES);
        const unofferable = COST_CATEGORIES.filter((c) => !offered.has(c));

        expect(unofferable).toEqual([]);
    });

    it('every category has a Bulgarian label', () => {
        // A category with no label renders as the raw key — `DEPRECIATION` in
        // a Bulgarian dropdown. It looks like a missing translation, so it gets
        // diagnosed as an i18n bug days later rather than as the enum change
        // that caused it. `i18n-diff --check` does not catch this: the key is
        // not missing from one locale, it was never added to either.
        const bg = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/bg.json'), 'utf8'));
        const labels = bg?.grainEnums?.costCategory ?? {};

        const unlabelled = COST_CATEGORIES.filter((c) => typeof labels[c] !== 'string');
        expect(unlabelled).toEqual([]);
    });

    it('the two new overhead categories are present in all three', () => {
        // The specific change this file was written alongside, pinned so a
        // revert is loud.
        for (const added of ['CREDIT', 'DEPRECIATION']) {
            expect(prismaEnumValues('CostCategory')).toContain(added);
            expect(COST_CATEGORIES as readonly string[]).toContain(added);
            expect(COST_CATEGORY_VALUES as readonly string[]).toContain(added);
        }
    });
});
