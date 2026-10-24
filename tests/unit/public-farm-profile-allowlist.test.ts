/**
 * The P6.1 field allowlist is exhaustive, and its halves agree with the schema
 * (#1810).
 *
 * Exhaustiveness itself is a COMPILE-TIME property —
 * `Record<keyof FarmBrand, FieldDecision>` refuses to compile if a column is
 * missing — so this file does not re-assert it. It asserts the things a type
 * cannot:
 *
 *   - a field marked `published` has somewhere to land on `PublicFarmProfile`.
 *     A published field with no column would be dropped silently, and the
 *     allowlist would claim to publish something the projection cannot hold.
 *   - a field marked `private` carries a real reason. `'private'` with an
 *     empty string is indistinguishable from an oversight, which is the state
 *     the allowlist exists to make impossible.
 *   - the DENOMINATOR. If `keyof FarmBrand` ever resolved to `never` — a
 *     generated-client problem, not a hypothetical in a repo where the Prisma
 *     client is a cross-branch global — the Record would be satisfied by `{}`
 *     and every assertion here would pass over an empty population.
 */
import { Prisma } from '@prisma/client';

import {
    BRAND_FIELD_DECISIONS,
    PUBLISHED_BRAND_FIELDS,
} from '@/app-layer/projections/public-farm-profile.allowlist';

/** Column names as the DMMF reports them, which is what the database has. */
function scalarFieldsOf(model: string): string[] {
    const m = Prisma.dmmf.datamodel.models.find((x) => x.name === model);
    if (!m) throw new Error(`${model} is not in the DMMF — the generated client is stale`);
    return m.fields.filter((f) => f.kind !== 'object').map((f) => f.name);
}

describe('the allowlist covers FarmBrand exactly', () => {
    it('control: the population is not empty', () => {
        // The denominator. Every assertion below ranges over these keys.
        const keys = Object.keys(BRAND_FIELD_DECISIONS);
        expect(keys.length).toBeGreaterThanOrEqual(10);
        expect(PUBLISHED_BRAND_FIELDS.length).toBeGreaterThan(0);
    });

    it('decides every FarmBrand scalar, and nothing that is not one', () => {
        // The runtime mirror of the compile-time Record. It catches the case a
        // type cannot: a key that is spelled right in TypeScript and wrong in
        // the database, which `@@map` makes possible.
        const schema = scalarFieldsOf('FarmBrand').sort();
        const decided = Object.keys(BRAND_FIELD_DECISIONS).sort();
        expect(decided).toEqual(schema);
    });

    it('every PUBLISHED field has a column on PublicFarmProfile', () => {
        // Otherwise the allowlist promises to publish something with nowhere
        // to land, and the writer would drop it without complaint.
        const projection = scalarFieldsOf('PublicFarmProfile');
        const orphans = PUBLISHED_BRAND_FIELDS.filter((f) => !projection.includes(f));
        expect(orphans).toEqual([]);
    });

    it('every PRIVATE field says why, in a sentence', () => {
        const thin: string[] = [];
        for (const [field, d] of Object.entries(BRAND_FIELD_DECISIONS)) {
            if (d.decision !== 'private') continue;
            // 40 chars is about one clause. A bare "internal" tells the next
            // reader nothing and is the shape this guards against.
            if (d.why.trim().length < 40) thin.push(field);
        }
        expect(thin).toEqual([]);
    });

    it('the PII columns are not on the projection at all, so they cannot be allowlisted', () => {
        // The structural half of P6.10's "0 hits" requirement. These live on
        // `FarmProfile`; if one ever appeared on `PublicFarmProfile`, the
        // allowlist would become the only thing standing between it and a
        // public page, and this says so before that happens.
        const projection = scalarFieldsOf('PublicFarmProfile');
        for (const pii of ['eik', 'urn', 'address', 'municipality', 'settlement']) {
            expect(projection).not.toContain(pii);
        }
        // …and they are on the private model, so the absence above is a
        // decision about where they live rather than them not existing.
        const privateModel = scalarFieldsOf('FarmProfile');
        // `egn` was in both lists until #2258 dropped the column. Replaced by
        // `urn` rather than just deleted: an entry naming a field that exists
        // nowhere passes the first loop for free and cannot fail the second.
        for (const pii of ['eik', 'urn', 'address', 'municipality', 'settlement']) {
            expect(privateModel).toContain(pii);
        }
    });

    it('tenantId is private, and that is the handle ruling made mechanical', () => {
        const d = BRAND_FIELD_DECISIONS.tenantId;
        expect(d.decision).toBe('private');
        // Named explicitly because it is the one field whose publication would
        // undo the owner's ruling that a handle is not the tenant slug.
        expect(projectionHas('tenantId')).toBe(false);
    });
});

function projectionHas(field: string): boolean {
    return scalarFieldsOf('PublicFarmProfile').includes(field);
}
