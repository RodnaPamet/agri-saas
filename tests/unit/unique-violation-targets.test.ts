/**
 * A P2002 must be narrowable whichever shape it arrives in.
 *
 * ## The defect this pins
 *
 * `asDuplicateNameConflict` translates a duplicate-name violation into
 * `ITEM_NAME_ALREADY_EXISTS`, and it narrowed on `err.meta.target` so that a
 * violation of some OTHER constraint would rethrow untouched. Sound reasoning;
 * wrong field.
 *
 * `meta.target` is populated only for indexes Prisma models from the schema.
 * The index this cares about — `Item_tenantId_name_active_key`, on
 * `(tenantId, lower(name)) WHERE deletedAt IS NULL` — is PARTIAL and
 * EXPRESSION-based, which Prisma cannot express, so it lives in raw SQL. Under
 * the Prisma 7 pg adapter such a violation arrives with `meta.target`
 * **undefined** and the constraint nested under `meta.driverAdapterError`.
 *
 * Measured against the real database before this was written:
 *
 *     code        'P2002'
 *     meta.target undefined
 *     meta.driverAdapterError.cause.constraint.index
 *                 'Item_tenantId_name_active_key'
 *
 * So the translation never fired and a raw `P2002` reached the client — on the
 * inventory product form as well as the new typed-name path. Nothing failed:
 * the translation was still present, still correct, and simply unreachable.
 * That is the shape worth guarding, because no test of the translation itself
 * would catch it.
 *
 * ## Why `originalMessage` is not a target
 *
 * Postgres puts the offending VALUE in its detail string — `Key (tenantId,
 * lower(name))=(…, карате зеон) already exists`. `src/lib/errors/types.ts`
 * copies a P2002's target into a client-facing `error.details`, so returning
 * that string would route row content to every client. The structured
 * `constraint.index` and `constraint.fields` are schema metadata and carry
 * none, which is what makes narrowing safe.
 */
import { uniqueViolationTargets } from '@/lib/errors/prisma';

/** The shape Prisma produces for an index it models from the schema. */
const schemaShape = {
    code: 'P2002',
    meta: { target: ['tenantId', 'name'], modelName: 'Item' },
};

/** The shape the pg driver adapter produces for a raw-SQL partial index. */
const adapterShape = {
    code: 'P2002',
    meta: {
        modelName: 'Item',
        driverAdapterError: {
            name: 'DriverAdapterError',
            cause: {
                originalCode: '23505',
                originalMessage:
                    'duplicate key value violates unique constraint "Item_tenantId_name_active_key"',
                kind: 'UniqueConstraintViolation',
                constraint: { index: 'Item_tenantId_name_active_key' },
                table: 'Item',
            },
        },
    },
};

describe('uniqueViolationTargets reads both P2002 shapes', () => {
    it('finds the columns in the schema shape', () => {
        expect(uniqueViolationTargets(schemaShape)).toEqual(
            expect.arrayContaining(['tenantId', 'name']),
        );
    });

    it('finds the index in the ADAPTER shape, where meta.target is undefined', () => {
        // The case that was broken. `meta.target` is absent here, so a reader
        // that only consulted it returned nothing and the caller rethrew.
        expect(schemaShape.meta.target).toBeDefined();
        expect((adapterShape.meta as { target?: unknown }).target).toBeUndefined();

        expect(uniqueViolationTargets(adapterShape)).toContain(
            'Item_tenantId_name_active_key',
        );
    });

    it('both shapes satisfy the `includes("name")` narrowing callers use', () => {
        // The actual predicate in `asDuplicateNameConflict`. Asserting it
        // directly is the point: the two previous cases could pass while the
        // caller still failed to match, since the index name and the column
        // name are different strings.
        for (const err of [schemaShape, adapterShape]) {
            expect(uniqueViolationTargets(err).some((t) => t.includes('name'))).toBe(true);
        }
    });

    it('does NOT return the driver message, which carries the offending value', () => {
        // A value-bearing string would read like an identifier to a caller and
        // reach `error.details` on the wire.
        const targets = uniqueViolationTargets(adapterShape);

        expect(targets).not.toContain(adapterShape.meta.driverAdapterError.cause.originalMessage);
        for (const t of targets) {
            expect(t).not.toContain('duplicate key value');
        }
    });

    it('returns structured fields when the adapter reports them instead of an index', () => {
        const withFields = {
            code: 'P2002',
            meta: {
                driverAdapterError: { cause: { constraint: { fields: ['tenantId', 'sku'] } } },
            },
        };

        expect(uniqueViolationTargets(withFields)).toEqual(
            expect.arrayContaining(['tenantId', 'sku']),
        );
    });

    it('is empty for an error with nothing to report, rather than throwing', () => {
        // This runs inside a catch block. A reader that threw on an unexpected
        // shape would replace a diagnosable P2002 with a TypeError from the
        // error handler, which is strictly worse than not narrowing.
        expect(uniqueViolationTargets(undefined)).toEqual([]);
        expect(uniqueViolationTargets(null)).toEqual([]);
        expect(uniqueViolationTargets(new Error('boom'))).toEqual([]);
        expect(uniqueViolationTargets({ code: 'P2002' })).toEqual([]);
        expect(uniqueViolationTargets({ code: 'P2002', meta: {} })).toEqual([]);
        expect(
            uniqueViolationTargets({ code: 'P2002', meta: { driverAdapterError: {} } }),
        ).toEqual([]);
    });

    it('control: an UNRELATED constraint does not satisfy the name narrowing', () => {
        // Otherwise the helper would be a catch-all, and a future constraint
        // would be relabelled as a name clash — sending someone to hunt the
        // wrong field, which is exactly what the narrow check was protecting
        // against before it stopped working.
        const other = {
            code: 'P2002',
            meta: {
                driverAdapterError: {
                    cause: { constraint: { index: 'Item_tenantId_sku_key' } },
                },
            },
        };

        expect(uniqueViolationTargets(other).some((t) => t.includes('name'))).toBe(false);
    });
});
