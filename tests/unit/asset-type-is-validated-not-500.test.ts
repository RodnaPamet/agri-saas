/**
 * An invalid `type` is a 400 at the schema, not a 500 at Prisma — #2950.
 *
 * `CreateAssetSchema.type` was `z.string().min(1)` while `Asset.type` is a
 * Prisma ENUM column. So `type: 'TRAKTOR'` passed validation, reached
 * `createAsset`, and failed as a `PrismaClientValidationError` — surfacing as a
 * 500, which tells a client nothing it can show a user. The two fields beside
 * it in the same object were already enums.
 *
 * `asset-schema-enums-match-prisma` is the STRUCTURAL half: it holds the
 * spelled-out member lists against the Prisma enums so the two copies cannot
 * drift. This is the BEHAVIOURAL half — that the schema actually refuses, and
 * actually accepts. A guard asserting source text proves the list is right and
 * never once runs the validator.
 */
import { CreateAssetSchema, UpdateAssetSchema } from '@/lib/schemas';

describe('#2950 — the asset type is validated before it reaches Prisma', () => {
    const valid = { name: 'Джон Дир 6155', type: 'TRACTOR' };

    it('accepts every member of the enum', () => {
        // The positive control, and it is per-member rather than one sample: a
        // schema narrowed to a SUBSET would refuse a value the column accepts,
        // which is a 400 the caller did not earn and strictly worse than the
        // 500 — it makes a legitimate machine uncreatable.
        for (const type of [
            'TRACTOR', 'HARVESTER', 'IMPLEMENT', 'VEHICLE', 'IRRIGATION',
            'BUILDING', 'STORAGE', 'LIVESTOCK_EQUIPMENT', 'TOOL', 'OTHER',
        ]) {
            expect(CreateAssetSchema.safeParse({ ...valid, type }).success).toBe(true);
        }
    });

    it.each([
        ['a typo', 'TRAKTOR'],
        ['a lowercased value', 'tractor'],
        ['a localised label', 'Трактор'],
        ['an empty string', ''],
    ])('REFUSES %s', (_label, type) => {
        // The four shapes a mobile client actually sends. Before #2950 every
        // one of these reached Prisma.
        expect(CreateAssetSchema.safeParse({ ...valid, type }).success).toBe(false);
    });

    it('refuses the same values on UPDATE, not only on create', () => {
        // #2950 named only the create schema. Narrowing that alone would have
        // left the identical 500 reachable by `PATCH` — which is the shape this
        // repo calls `count-the-routes-a-gate-covers`.
        expect(UpdateAssetSchema.safeParse({ type: 'TRAKTOR' }).success).toBe(false);
        expect(UpdateAssetSchema.safeParse({ type: 'TRACTOR' }).success).toBe(true);
        // And `type` stays OPTIONAL on update: a PATCH that changes only the
        // name must not be forced to restate the type.
        expect(UpdateAssetSchema.safeParse({ name: 'Нов етикет' }).success).toBe(true);
    });

    it('still requires a type on CREATE', () => {
        // The narrowing must not have made it optional by accident — an asset
        // with no type would reach a NOT NULL column.
        const { type: _dropped, ...withoutType } = valid;
        expect(CreateAssetSchema.safeParse(withoutType).success).toBe(false);
    });
});
