/**
 * Asset and evidence dates refuse what cannot be parsed (#1558).
 *
 * ## The last four of #1558's twenty-four
 *
 * The issue listed 24 unvalidated date-ish fields. Audited, that resolved to:
 * 5 already fixed (#1563, #1565), 4 that were never request-side, 11 guarded
 * elsewhere, and these 4.
 *
 *     index.ts:42   purchaseDate     CreateAssetSchema      -> asset.ts:19-23
 *     index.ts:63   purchaseDate     UpdateAssetSchema      -> asset.ts:19-23
 *     index.ts:140  nextReviewDate   _CreateEvidenceBase    -> evidence.ts:148
 *                                      (exported as CreateEvidenceSchema)
 *     index.ts:163  nextReviewDate   UpdateEvidenceSchema   -> evidence.ts:192
 *
 * The third row cost me a second attribution error of the same kind as #1443's.
 * I walked backward for `export const \w+Schema` and landed on
 * `CreatePracticeSchema`, which has no date field at all — because line 126 is
 * `const _CreateEvidenceBase = z.object({`, NOT exported, so the scan went
 * straight past it. There are FIVE non-exported `const …Schema` declarations in
 * this one file, `HarvestLotPayloadSchema` (the #1443 instance) among them, so
 * any field inside one is attributable to the wrong parent by the same
 * mechanism. The positive control is what caught it: the baseline payload for
 * `CreatePracticeSchema` could not possibly carry a `nextReviewDate`.
 *
 * Both consumers convert without checking:
 *
 *     // asset.ts:19-23
 *     function normalizePurchaseDate(value: unknown): Date | null | undefined {
 *         if (value === undefined) return undefined;
 *         if (!value) return null;
 *         return new Date(value as string);          // <- no isNaN check
 *     }
 *
 *     // evidence.ts:148
 *     nextReviewDate: data.nextReviewDate ? new Date(data.nextReviewDate) : null,
 *
 * Both columns are `DateTime?`, so an Invalid Date reaches Prisma and the
 * request 500s where the contract says 400.
 *
 * ## Checked in THREE places before calling them unguarded
 *
 * The audit of this list got one field wrong by checking only two. Validation
 * lives at the field, at the OBJECT (a `.superRefine` on the schema, which is
 * how `CalendarQuerySchema` turned out to be safe all along), and at the
 * consumer. For these four:
 *
 *   - field:    bare `z.string().optional().nullable()`
 *   - object:   the only `superRefine` in `index.ts` is at :732, in a
 *               different schema entirely
 *   - consumer: the two unguarded `new Date(...)` calls above
 *
 * All three empty, which is what makes these real where calendar was not.
 */
import { z } from 'zod';

import {
    CreateAssetSchema,
    UpdateAssetSchema,
    CreateEvidenceSchema,
    UpdateEvidenceSchema,
} from '@/lib/schemas';

const CASES = [
    { label: 'CreateAssetSchema.purchaseDate', schema: CreateAssetSchema, field: 'purchaseDate', valid: { name: 'Tractor', type: 'MACHINE' } },
    { label: 'UpdateAssetSchema.purchaseDate', schema: UpdateAssetSchema, field: 'purchaseDate', valid: {} },
    { label: 'CreateEvidenceSchema.nextReviewDate', schema: CreateEvidenceSchema, field: 'nextReviewDate', valid: { title: 'A document' } },
    { label: 'UpdateEvidenceSchema.nextReviewDate', schema: UpdateEvidenceSchema, field: 'nextReviewDate', valid: {} },
] as const;

describe('asset + evidence dates reject unparseable input (#1558)', () => {
    describe.each(CASES.map((c) => [c.label, c] as const))('%s', (_label, c) => {
        it('the baseline payload parses — the positive control', () => {
            // Without this, every rejection below could be a schema failing
            // for an unrelated reason and would read as validation.
            expect(c.schema.safeParse(c.valid).success).toBe(true);
        });

        it.each([
            ['a bare day', '2026-10-08'],
            ['a UTC instant', '2026-10-08T00:00:00.000Z'],
            ['an explicit offset', '2026-10-08T03:00:00+03:00'],
        ])('accepts %s — these are day-typed fields', (_l, value) => {
            // A purchase date and a review date are days in the books. The
            // instant-only validator would be wrong here, and these
            // assertions are what stop that swap.
            expect(c.schema.safeParse({ ...c.valid, [c.field]: value }).success).toBe(true);
        });

        it('keeps null and omitted working — asset.ts distinguishes them', () => {
            // `normalizePurchaseDate` returns `undefined` for omitted and
            // `null` for empty, and the repository treats those differently
            // (leave unchanged vs clear). Both must survive the tightening.
            expect(c.schema.safeParse({ ...c.valid, [c.field]: null }).success).toBe(true);
            expect(c.schema.safeParse(c.valid).success).toBe(true);
        });

        it.each(['abcd', 'not-a-date', '2026-13-45', 'next week', '   '])(
            'REFUSES %p',
            (bad) => {
                expect(c.schema.safeParse({ ...c.valid, [c.field]: bad }).success).toBe(false);
            },
        );
    });

    it('those inputs really were Invalid Dates — the premise', () => {
        for (const bad of ['abcd', 'not-a-date', '2026-13-45', 'next week']) {
            expect(new Date(bad).getTime()).toBeNaN();
        }
    });

    it('the shape they REPLACED accepted all of them — the control', () => {
        // Reconstructs the old declaration rather than poking at the live
        // schema's internals, so the comparison is between two things this
        // test can both evaluate.
        const before = z.object({ purchaseDate: z.string().optional().nullable() });
        for (const bad of ['abcd', 'not-a-date', '2026-13-45']) {
            expect(before.safeParse({ purchaseDate: bad }).success).toBe(true);
            expect(
                CreateAssetSchema.safeParse({ name: 'Tractor', type: 'MACHINE', purchaseDate: bad })
                    .success,
            ).toBe(false);
        }
    });
});
