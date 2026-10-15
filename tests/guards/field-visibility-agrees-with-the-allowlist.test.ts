/**
 * The eye toggles and the publication allowlist agree, exhaustively — P6.6 (#1815).
 *
 * ## The two failures this exists for, stated by the issue itself
 *
 * > a field visible in the editor but absent from the allowlist is a control
 * > that does nothing, and a field in the allowlist with no toggle is
 * > published with no way to withdraw it. Worth a test that enumerates both
 * > and asserts they agree, rather than two lists maintained by hand.
 *
 * Both are silent. A toggle for an unpublished field is a switch a farmer
 * flips with no effect on anything a visitor sees; a published field with no
 * toggle is content they cannot withhold and may not know is public.
 *
 * ## Why a partition rather than a list
 *
 * `HIDEABLE_FIELDS` + `NOT_HIDEABLE` are asserted to cover every `published()`
 * field EXACTLY ONCE. A list of hideable fields could only be checked for
 * membership — this can be checked for COMPLETENESS, so a new public field
 * must arrive with a toggle or with a written reason it has none. There is no
 * third option and no default.
 *
 * ## The columns are checked against the SCHEMA, not against each other
 *
 * `HIDEABLE_FIELDS` maps a field to the column that hides it. Both directions
 * are asserted against `FarmBrand` as the schema actually declares it, so a
 * renamed column fails here rather than becoming a toggle that writes nothing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parseSchemaModels } from '../helpers/prisma-schema-models';
import {
    BRAND_FIELD_DECISIONS,
    HIDEABLE_FIELDS,
    NOT_HIDEABLE,
} from '@/app-layer/projections/public-farm-profile.allowlist';

const farmBrand = () => {
    const m = parseSchemaModels().find((x) => x.name === 'FarmBrand');
    if (!m) throw new Error('FarmBrand not found in the schema');
    return m;
};

const publishedFields = Object.entries(BRAND_FIELD_DECISIONS)
    .filter(([, d]) => d.decision === 'published')
    .map(([k]) => k)
    .sort();

describe('per-field visibility agrees with the publication allowlist', () => {
    it('control: there are published fields to partition', () => {
        // An empty published set would satisfy every assertion below for free.
        expect(publishedFields.length).toBeGreaterThanOrEqual(5);
    });

    it('every published field is either hideable or exempt, exactly once', () => {
        const hideable = Object.keys(HIDEABLE_FIELDS);
        const exempt = Object.keys(NOT_HIDEABLE);

        // No overlap: a field cannot be both.
        expect(hideable.filter((f) => exempt.includes(f))).toEqual([]);
        // No gap: the union IS the published set.
        expect([...hideable, ...exempt].sort()).toEqual(publishedFields);
    });

    it('nothing is hideable that is not published', () => {
        // The first half of #1815's sentence: a control that does nothing.
        for (const field of Object.keys(HIDEABLE_FIELDS)) {
            expect(BRAND_FIELD_DECISIONS[field as keyof typeof BRAND_FIELD_DECISIONS]).toEqual({
                decision: 'published',
            });
        }
    });

    it('every toggle names a real column, and every hide column has a toggle', () => {
        const columns = new Set(farmBrand().scalarFieldNames);

        // Forward: the column a toggle writes exists.
        for (const [field, column] of Object.entries(HIDEABLE_FIELDS)) {
            expect({ field, column, exists: columns.has(column) }).toEqual({
                field,
                column,
                exists: true,
            });
        }

        // Reverse: no orphan `hide*` column that nothing can set — which is
        // how a renamed field leaves a dead column behind.
        const hideColumns = [...columns].filter((c) => /^hide[A-Z]/.test(c)).sort();
        expect(hideColumns).toEqual(Object.values(HIDEABLE_FIELDS).sort());
    });

    it('every exemption carries a real reason', () => {
        // A reason that is an empty string, or a restatement of the field
        // name, is the shape of an exemption added to make this test pass.
        for (const [field, why] of Object.entries(NOT_HIDEABLE)) {
            expect(why.length).toBeGreaterThan(40);
            expect(why.toLowerCase()).not.toBe(field.toLowerCase());
        }
    });
});
